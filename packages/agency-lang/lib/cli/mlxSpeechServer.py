"""An OpenAI-style /v1/audio/speech server for one MLX speech model.

Started by `agency local serve --speech <model>`. Loads the model once with
mlx-audio, then answers:

  POST /v1/audio/speech  {"model", "input", "voice"?, "instructions"?, "response_format"?}
  GET  /v1/models
  GET  /health

A success is the audio bytes: WAV, or raw 16-bit little-endian mono PCM at
the model's sample rate. A failure is {"error": {"message": "..."}}.

The request rules (families, voices, formats, the text limit) are in
mlxSpeechRules.py, which imports nothing from MLX so CI can test them. This
file is the part that needs a Mac.
"""

import argparse
import importlib.metadata
import io
import json
import os
import select
import socket
import sys
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mlxSpeechRules import (  # noqa: E402
    FAMILIES,
    FORMATS,
    MLX_AUDIO_VERSION,
    MODEL_VOICES,
    RequestError,
    check_request,
    family_of,
    split_sentences,
    warm_up_request,
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="model directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--models-dir",
        default="",
        help="Agency's models directory; companion repos are looked up under <dir>/mlx",
    )
    return parser.parse_args()


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def check_mlx_audio_version():
    # The package defines no __version__; the distribution metadata is the
    # one place the installed version is recorded.
    try:
        found = importlib.metadata.version("mlx-audio")
    except importlib.metadata.PackageNotFoundError:
        found = "not installed"
    if found != MLX_AUDIO_VERSION:
        fail(
            f"mlxSpeechServer.py was written against mlx-audio {MLX_AUDIO_VERSION} and this "
            f"Python has {found}. Install the tested version:\n"
            f"  {sys.executable} -m pip install mlx-audio=={MLX_AUDIO_VERSION}"
        )


def read_config(model_dir):
    with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as f:
        return json.load(f)


def client_gone(sock):
    """True when the client has closed its side. Checked between sentences,
    since a generation already running cannot be stopped."""
    if sock is None:
        return False
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


def to_pcm16(samples):
    import numpy as np

    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767).astype("<i2")


def patch_mlx_audio_for_orpheus(model_dir, models_dir):
    """Three fixes to mlx-audio 0.5.4, applied before the Orpheus module is
    imported, because importing it loads the SNAC decoder. Each one names
    the upstream report. Remove each when a release carries the fix and the
    version pin moves."""
    import mlx_audio.codec.models.snac.snac as snac_module
    import mlx_audio.lm.generate as lm_generate

    # 1. SNAC is loaded by repo id at import time (llama.py:32) through
    #    huggingface_hub, which cannot run offline on an empty cache. Look
    #    in Agency's models directory first; fall back to the original for a
    #    cache that already holds it. Upstream: UPSTREAM_ISSUE.
    original_fetch = snac_module.fetch_from_hub

    def fetch_from_models_dir(hf_repo):
        candidate = os.path.join(models_dir, "mlx", hf_repo.replace("/", "--"))
        if models_dir and os.path.isfile(os.path.join(candidate, "config.json")):
            return Path(candidate)
        try:
            return original_fetch(hf_repo)
        except Exception as err:  # huggingface_hub raises several types offline
            raise RequestError(
                f"This Orpheus model needs {hf_repo}, which is not downloaded. Run:\n"
                f"  agency local download mlx:{hf_repo}\n"
                f"and serve it again. ({err})"
            ) from err

    snac_module.fetch_from_hub = fetch_from_models_dir

    # 2. eos_token_ids is one int for the Orpheus tokenizer, and set(int)
    #    raises. Upstream: UPSTREAM_ISSUE.
    original_eos_ids = lm_generate._eos_ids

    def eos_ids(tokenizer):
        ids = getattr(tokenizer, "eos_token_ids", None)
        if isinstance(ids, int):
            return {ids}
        return original_eos_ids(tokenizer)

    lm_generate._eos_ids = eos_ids

    # 3. The tokenizer is loaded by repo id from the full-size bf16 repo
    #    (llama.py:21). The 4-bit repo has its own tokenizer files, so load
    #    it from the model directory. The loader builds ModelConfig with
    #    from_dict, so the name has to go into the dict; the dataclass
    #    default is fixed at class creation. Upstream: UPSTREAM_ISSUE.
    #    This import loads SNAC, so patch 1 above has to come first.
    import mlx_audio.tts.models.llama.llama as llama_module

    original_from_dict = llama_module.ModelConfig.from_dict

    def from_dict_with_local_tokenizer(params):
        return original_from_dict({**params, "tokenizer_name": model_dir})

    llama_module.ModelConfig.from_dict = staticmethod(from_dict_with_local_tokenizer)


class Speaker:
    """The loaded model, its family, its speakers, and a lock, because MLX
    runs one computation at a time."""

    def __init__(self, model_dir, models_dir=""):
        config = read_config(model_dir)
        self.family = family_of(config)
        self.rules = FAMILIES[self.family]
        if self.family == "orpheus":
            patch_mlx_audio_for_orpheus(model_dir, models_dir)
        # Imported here, after the patches: load_model imports the model's
        # own module, and the Orpheus one loads SNAC as it is imported.
        from mlx_audio.tts.utils import load_model

        self.model = load_model(model_dir)
        self.speakers = (
            [name.lower() for name in self.model.get_supported_speakers()]
            if self.rules["voices"] == MODEL_VOICES
            else []
        )
        self.lock = threading.Lock()

    def generate_kwargs(self, request):
        kwargs = {"max_tokens": self.rules["max_tokens"]}
        if request["voice"] != "":
            kwargs["voice"] = request["voice"]
        if request["instructions"] != "":
            kwargs["instruct"] = request["instructions"]
        return kwargs

    def results(self, request, sock):
        """The model's results for a request, one sentence at a time, or
        None when the client hung up. Checked between sentences, so a
        hang-up stops after the sentence in progress."""
        kwargs = self.generate_kwargs(request)
        results = []
        for sentence in split_sentences(request["text"]):
            if client_gone(sock):
                return None
            results.extend(self.model.generate(sentence, **kwargs))
        return results

    def speak(self, request, sock):
        """The samples and the sample rate for a request, or None when the
        client hung up. `sock` is None for the warm-up, which nobody can
        hang up on."""
        import numpy as np

        with self.lock:
            results = self.results(request, sock)
        if results is None:
            return None
        if not results:
            raise RequestError("The model produced no audio.", status=500)
        samples = np.concatenate(
            [np.asarray(result.audio, dtype=np.float32).reshape(-1) for result in results]
        )
        return samples, results[-1].sample_rate

    def warm_up(self):
        """One short generation with the family's own defaults, before the
        port opens. A model that loads but cannot speak fails here, and
        `agency local serve` reports the exit instead of the user's first
        call finding it."""
        request = check_request(self.family, self.speakers, warm_up_request(self.family))
        self.speak(request, None)


def encode(samples, sample_rate, fmt):
    if fmt == "pcm":
        return to_pcm16(samples).tobytes()
    from mlx_audio.audio_io import write

    buf = io.BytesIO()
    write(buf, samples, sample_rate, format="wav")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    speaker = None
    served_name = ""

    def log_message(self, fmt, *args):
        # Quiet on success; `agency local serve` shows its own status lines.
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
            self.send_json(200, {"status": "ok"})
        elif self.path == "/v1/models":
            self.send_json(
                200, {"object": "list", "data": [{"id": self.served_name, "object": "model"}]}
            )
        else:
            self.send_error_json(404, f"{self.path} is not a route this server has.")

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            self.send_error_json(
                404,
                f"{self.path} is not a route this server has. It serves speech only; "
                "chat requests go to a chat model.",
            )
            return
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.send_error_json(400, "Request body is not JSON.")
            return
        if not isinstance(body, dict):
            self.send_error_json(400, "Request body must be a JSON object.")
            return
        try:
            request = check_request(self.speaker.family, self.speaker.speakers, body)
            spoken = self.speaker.speak(request, self.connection)
            if spoken is None:
                # The client hung up; there is nobody to answer.
                return
            audio = encode(spoken[0], spoken[1], request["format"])
        except RequestError as err:
            self.send_error_json(err.status, str(err))
            return
        except Exception as err:  # noqa: BLE001
            # Without a reply the caller would see only "socket hang up".
            self.send_error_json(500, f"Generation failed: {err}")
            return
        try:
            self.send_response(200)
            self.send_header("content-type", FORMATS[request["format"]])
            self.send_header("content-length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except (BrokenPipeError, ConnectionResetError):
            # The client hung up while the audio was being encoded.
            return


def main():
    args = parse_args()
    check_mlx_audio_version()
    try:
        # Load and speak once before binding the port. `agency local serve`
        # treats a refused connection as "still loading" and any answer as
        # "ready", so the port must stay closed until the model can answer.
        Handler.speaker = Speaker(args.model, args.models_dir)
        Handler.speaker.warm_up()
    except RequestError as err:
        fail(str(err))
    Handler.served_name = args.model
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
