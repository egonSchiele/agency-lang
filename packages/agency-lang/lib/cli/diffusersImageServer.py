"""An OpenAI-style /v1/images/generations server for one diffusers model.

Started by `agency local serve <model>`. Loads the model once on the Mac
GPU, loads LoRA adapters from `--adapters-dir` as requests name them, and
answers:

  POST /v1/images/generations  {"prompt", "size"?, "steps"?, "guidance"?, "seed"?,
                                "negative_prompt"?, "output_format"?, "response_format"?, "n"?,
                                "lora"?, "lora_scale"?}
  GET  /v1/models
  GET  /health                 {"status": "ok", "adapters": [names]}

A success is {"created", "output_format", "data": [{"b64_json", "seed"}]}.
A failure is {"error": {"message": "..."}}.

The rules (families, the components each may load, sizes, steps, the
fields a request may carry) are in diffusersImageRules.py, which imports
nothing from torch so CI can test it. This file is the part that needs a
Mac.
"""

import argparse
import base64
import importlib.metadata
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from localServerCommon import client_gone, fail  # noqa: E402
from diffusersImageRules import (  # noqa: E402
    DIFFUSERS_VERSION,
    RequestError,
    check_request,
    join_names,
    family_of,
    adapter_names,
    adapter_path,
    warm_up_request,
)

GENERATIONS_PATH = "/v1/images/generations"

# A request body is a prompt and a few settings. Anything bigger is not a
# request this server makes sense of.
MAX_BODY_BYTES = 64 * 1024

PIL_FORMATS = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="model directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--adapters-dir",
        default=None,
        help="the folder LoRA adapters (.safetensors) are loaded from, by name, as requests ask",
    )
    return parser.parse_args()


def check_adapters_dir(adapters_dir):
    """The folder, once it is known to be a directory and not a symlink, or
    None. Fails before the model loads, so a wrong path costs seconds. A
    family that takes no adapters is not refused the folder: a request
    naming one is refused instead, since the folder is one config key for
    every image model the user serves."""
    if adapters_dir is None:
        return None
    if os.path.islink(adapters_dir):
        fail(f"--adapters-dir {adapters_dir} is a symlink. Name the folder itself.")
    if not os.path.isdir(adapters_dir):
        fail(f"--adapters-dir {adapters_dir} is not a folder.")
    return adapters_dir


def check_diffusers_version():
    try:
        found = importlib.metadata.version("diffusers")
    except importlib.metadata.PackageNotFoundError:
        found = "not installed"
    if found != DIFFUSERS_VERSION:
        fail(
            f"diffusersImageServer.py was written against diffusers {DIFFUSERS_VERSION} and "
            f"this Python has {found}. Install the tested version:\n"
            f"  {sys.executable} -m pip install diffusers=={DIFFUSERS_VERSION}"
        )


def read_model_index(model_dir):
    with open(os.path.join(model_dir, "model_index.json"), encoding="utf-8") as f:
        return json.load(f)


class ClientGone(Exception):
    """Raised from the step callback to stop a generation nobody is waiting
    for."""


class Generator:
    """The loaded pipeline, its family, and a lock, because the GPU runs one
    generation at a time."""

    def __init__(self, model_dir, adapters_dir):
        # The file names the classes from_pretrained will import, so it is
        # checked before anything from diffusers is imported.
        try:
            self.rules = family_of(read_model_index(model_dir))
        except ValueError as err:
            fail(str(err))
        self.adapters_dir = check_adapters_dir(adapters_dir)
        # The adapters loaded so far, by name. An adapter is loaded the
        # first time a request names it and kept.
        self.loaded = []
        # Never fetch anything while serving. Set before diffusers and
        # huggingface_hub are imported, since they read it at import time.
        os.environ["HF_HUB_OFFLINE"] = "1"
        import torch
        import diffusers
        import transformers

        diffusers.utils.logging.disable_progress_bar()
        transformers.utils.logging.disable_progress_bar()
        if not torch.backends.mps.is_available():
            fail("diffusersImageServer.py needs the Mac GPU (torch's mps device), and it is not available.")
        # The class comes from the family table, never from the file.
        pipeline_class = getattr(diffusers, self.rules["pipeline"])
        # use_safetensors: a .bin weight loads through pickle, which runs
        # code. trust_remote_code and custom_pipeline are never passed.
        self.pipe = pipeline_class.from_pretrained(
            model_dir,
            dtype=torch.bfloat16,
            use_safetensors=True,
            local_files_only=True,
        ).to("mps")
        # A progress bar per request would fill the terminal `serve` runs in.
        self.pipe.set_progress_bar_config(disable=True)
        self.torch = torch
        self.lock = threading.Lock()

    def load_adapter(self, name):
        """Loads the adapter `name` from the folder the first time it is
        asked for. The file is .safetensors, so loading it reads tensors and
        never runs code. A missing file is a 400 naming what the folder
        holds. Called under the lock, since the adapter state is the
        pipeline's."""
        if name in self.loaded:
            return
        path = adapter_path(self.adapters_dir, name)
        if os.path.islink(path) or not os.path.isfile(path):
            have = adapter_names(self.adapters_dir)
            listing = join_names(have) if have else "no adapters"
            raise RequestError(
                f'There is no adapter "{name}" in {self.adapters_dir}. It has {listing}.'
            )
        self.pipe.load_lora_weights(path, adapter_name=name)
        self.loaded.append(name)

    def apply_lora(self, request):
        """Switch the loaded adapters to what this request asked for: one
        adapter at its scale, or none. Called under the lock."""
        if request["lora"] is None:
            if self.loaded:
                self.pipe.disable_lora()
            return
        self.load_adapter(request["lora"])
        self.pipe.enable_lora()
        self.pipe.set_adapters([request["lora"]], adapter_weights=[request["lora_scale"]])

    def generate(self, request, sock):
        """The image for a checked request, or None when the client hung up.
        `sock` is None for the warm-up, which nobody can hang up on."""
        torch = self.torch
        total = request["steps"]

        def on_step_end(pipe, step, timestep, callback_kwargs):
            # The GPU runs behind Python: without this wait, the loop queues
            # every step within a second and this check runs long before
            # the client could have hung up. The timing run measured no
            # slowdown from waiting.
            torch.mps.synchronize()
            if client_gone(sock):
                raise ClientGone(step + 1)
            return callback_kwargs

        kwargs = {
            "prompt": request["prompt"],
            "height": request["height"],
            "width": request["width"],
            "num_inference_steps": total,
            "guidance_scale": request["guidance"],
            "generator": torch.Generator("cpu").manual_seed(request["seed"]),
            "callback_on_step_end": on_step_end,
        }
        if request["negative_prompt"] != "":
            kwargs["negative_prompt"] = request["negative_prompt"]
        with self.lock:
            # A client that hung up while it waited for the lock gets
            # nothing started at all.
            if client_gone(sock):
                return None
            self.apply_lora(request)
            try:
                return self.pipe(**kwargs).images[0]
            except ClientGone as gone:
                print(
                    f"Stopped after {gone.args[0]} of {total} steps: the client hung up.",
                    file=sys.stderr,
                )
                return None

    def warm_up(self):
        """One small generation before the port opens. A model that loads
        but cannot generate fails here, and `agency local serve` reports the
        exit instead of the user's first call finding it."""
        self.generate(check_request(self.rules, warm_up_request(), self.adapters_dir), None)


def encode(image, fmt):
    buf = io.BytesIO()
    image.save(buf, format=PIL_FORMATS[fmt])
    return base64.b64encode(buf.getvalue()).decode("ascii")


class Handler(BaseHTTPRequestHandler):
    generator = None
    served_name = ""

    def log_message(self, fmt, *args):
        # Quiet on success; `agency local serve` logs each request itself.
        return

    def send_json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, status, message):
        self.send_json(status, {"error": {"message": message}})

    def do_GET(self):
        if self.path == "/health":
            folder = self.generator.adapters_dir
            adapters = [] if folder is None else adapter_names(folder)
            self.send_json(200, {"status": "ok", "adapters": adapters})
        elif self.path == "/v1/models":
            self.send_json(
                200, {"object": "list", "data": [{"id": self.served_name, "object": "model"}]}
            )
        else:
            self.send_error_json(404, f"{self.path} is not a route this server has.")

    def read_body(self):
        """The parsed JSON body. Raises RequestError for a missing, too
        large, or unparsable one."""
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            raise RequestError("content-length is not a number.")
        if length > MAX_BODY_BYTES:
            raise RequestError(
                f"The request body is {length:,} bytes; this server takes at most {MAX_BODY_BYTES:,}.",
                status=413,
            )
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise RequestError("Request body is not JSON.")

    def do_POST(self):
        if self.path != GENERATIONS_PATH:
            self.send_error_json(
                404,
                f"{self.path} is not a route this server has. It serves images only, at "
                f"{GENERATIONS_PATH}.",
            )
            return
        try:
            request = check_request(
                self.generator.rules, self.read_body(), self.generator.adapters_dir
            )
            image = self.generator.generate(request, self.connection)
            if image is None:
                # The client hung up; there is nobody to answer.
                return
            data = encode(image, request["output_format"])
        except RequestError as err:
            self.send_error_json(err.status, str(err))
            return
        except Exception as err:  # noqa: BLE001
            # Without a reply the caller would see only "socket hang up".
            self.send_error_json(500, f"Generation failed: {err}")
            return
        try:
            self.send_json(
                200,
                {
                    "created": int(time.time()),
                    "output_format": request["output_format"],
                    "data": [{"b64_json": data, "seed": request["seed"]}],
                },
            )
        except (BrokenPipeError, ConnectionResetError):
            # The client hung up while the image was being encoded.
            return


def main():
    args = parse_args()
    check_diffusers_version()
    # Load and generate once before binding the port. `agency local serve`
    # treats a refused connection as "still loading" and any answer as
    # "ready", so the port must stay closed until the model can answer.
    Handler.generator = Generator(args.model, args.adapters_dir)
    Handler.generator.warm_up()
    Handler.served_name = args.model
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
