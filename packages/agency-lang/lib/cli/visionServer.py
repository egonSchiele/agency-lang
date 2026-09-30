"""A server for one vision model: boxes, tags, or a caption for an image
on this machine.

Started by `agency local serve <model>` for a model whose kind is vision.
Loads the model once, then answers, each with {"model", "image": <base64
of the image's bytes>, ...}:

  POST /v1/vision/detections  {"labels": [...], "threshold"?}  -> {"detections": [{"label", "score", "box"}]}
  POST /v1/vision/tags        {"threshold"?, "limit"?}          -> {"tags": [{"tag", "score"}]}
  POST /v1/vision/captions    {"detail"?: "short" | "long"}     -> {"caption": "..."}
  GET  /health                                                  -> {"status": "ok", "routes": [...]}

A failure is {"error": {"message": "..."}}. A route the model does not
answer is a 404 naming the ones it does.

The image comes as bytes, never as a path. The stdlib raised an effect
for the file, read it after the user approved, and sent what it read.
The server opens no file a request names, so a process that reaches the
port can describe only images it already has. It never lists a
directory and never writes.

The rules (families, routes, the fields a request may carry) are in
visionRules.py, which imports nothing from torch or onnxruntime so CI can
test it. This file is the part that needs the libraries.
"""

import argparse
import base64
import csv
import importlib.metadata
import io
import json
import os
import sys
import threading
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from localServerCommon import client_gone, fail  # noqa: E402
from visionRules import (  # noqa: E402
    MAX_BODY_BYTES,
    ONNXRUNTIME_VERSION,
    TRANSFORMERS_VERSION,
    RequestError,
    box_pixels,
    check_request,
    family_of,
    join_names,
    normalized_box,
    route_of_path,
    route_paths,
    square_padding,
    warm_up_request,
)

# The formats Pillow may decode a request's bytes as. Anything else is
# refused before a decoder for it runs.
IMAGE_FORMATS = ["PNG", "JPEG", "WEBP", "GIF"]

# An image with more pixels than this is refused, which guards against a
# small file that decodes to a huge one.
MAX_IMAGE_PIXELS = 100_000_000

# WD14 tag categories in selected_tags.csv: general tags describe the
# picture; the rest are ratings and character names.
WD14_GENERAL = "0"

# Florence-2 generation settings from the model card.
FLORENCE_MAX_NEW_TOKENS = 1024
FLORENCE_BEAMS = 3

# The side DINOv2 takes a picture at: the size its model card crops to.
DINOV2_INPUT_SIZE = 224


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="model directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    return parser.parse_args()


def check_version(package, wanted):
    try:
        found = importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        found = "not installed"
    if found != wanted:
        fail(
            f"visionServer.py was written against {package} {wanted} and this Python has "
            f"{found}. Install the tested version:\n  {sys.executable} -m pip install {package}=={wanted}"
        )


def read_config(model_dir):
    try:
        with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def open_image(data):
    """A Pillow image, in RGB, for the bytes a request sent. Raises
    RequestError for bytes that are not an image in IMAGE_FORMATS or that
    decode to more than MAX_IMAGE_PIXELS."""
    from PIL import Image, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with warnings.catch_warnings():
            # Pillow only warns between the limit and twice it; refuse there too.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            return Image.open(io.BytesIO(data), formats=IMAGE_FORMATS).convert("RGB")
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise RequestError(f"The image has more than {MAX_IMAGE_PIXELS:,} pixels; this server refuses it.")
    except UnidentifiedImageError:
        raise RequestError(f"The image is not one this server reads. It reads {join_names(IMAGE_FORMATS, 'or')}.")


def padded_square(image, color):
    """`image` centered on a square of `color`, so a processor that makes
    a picture square does not cut the ends off a long, thin one."""
    from PIL import Image

    side, offset = square_padding(*image.size)
    square = Image.new("RGB", (side, side), color)
    square.paste(image, offset)
    return square


class Wd14Runner:
    """The WD14 tagger: an ONNX classifier over booru tags. Answers `tags`."""

    def __init__(self, model_dir, rules):
        check_version("onnxruntime", ONNXRUNTIME_VERSION)
        import numpy
        import onnxruntime

        self.numpy = numpy
        self.session = onnxruntime.InferenceSession(
            os.path.join(model_dir, rules["identify_file"]), providers=["CPUExecutionProvider"]
        )
        self.input = self.session.get_inputs()[0]
        self.size = self.input.shape[1]
        self.tags = []
        with open(os.path.join(model_dir, rules["identify_beside"]), newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                self.tags.append((row["name"].replace("_", " "), row["category"] == WD14_GENERAL))

    def _prepare(self, image):
        """WD14 input: square, white-padded, BGR, float32, no normalisation."""
        from PIL import Image

        numpy = self.numpy
        width, height = image.size
        side = max(width, height)
        square = Image.new("RGB", (side, side), (255, 255, 255))
        square.paste(image, ((side - width) // 2, (side - height) // 2))
        square = square.resize((self.size, self.size), Image.BICUBIC)
        array = numpy.asarray(square, dtype=numpy.float32)[:, :, ::-1]
        return numpy.expand_dims(array, 0)

    def tags_of(self, image, request):
        probs = self.session.run(None, {self.input.name: self._prepare(image)})[0][0]
        found = [
            {"tag": name, "score": round(float(prob), 4)}
            for (name, general), prob in zip(self.tags, probs)
            if general and prob >= request["threshold"]
        ]
        found.sort(key=lambda t: -t["score"])
        return {"tags": found[: request["limit"]]}


class Florence2Runner:
    """Florence-2: one model that detects with a label list, captions, and
    names regions. Answers `detections`, `tags`, and `captions`."""

    def __init__(self, model_dir, rules):
        check_version("transformers", TRANSFORMERS_VERSION)
        import torch
        import transformers

        transformers.utils.logging.disable_progress_bar()
        self.torch = torch
        self.rules = rules
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        # trust_remote_code is never passed: the class comes from the
        # library, not from a file in the model directory.
        self.processor = transformers.AutoProcessor.from_pretrained(model_dir, local_files_only=True)
        self.model = transformers.Florence2ForConditionalGeneration.from_pretrained(
            model_dir, use_safetensors=True, local_files_only=True, dtype=torch.float32
        ).to(self.device)

    def _run(self, image, task, text=""):
        """The parsed answer for one task token, as the processor shapes it."""
        inputs = self.processor(text=task + text, images=image, return_tensors="pt").to(self.device)
        with self.torch.no_grad():
            generated = self.model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=FLORENCE_MAX_NEW_TOKENS,
                num_beams=FLORENCE_BEAMS,
                do_sample=False,
            )
        text_out = self.processor.batch_decode(generated, skip_special_tokens=False)[0]
        parsed = self.processor.post_process_generation(text_out, task=task, image_size=image.size)
        return parsed[task]

    def detections_of(self, image, request):
        # The detection task takes one phrase: "Locate {phrase} in the
        # image." Given "person, desk, chair" it looks for that whole
        # phrase. So each label is its own pass, and each box is labeled
        # with the label that was asked for, not the text the model wrote
        # back. Florence-2 gives no score, so every box scores 1.
        width, height = image.size
        found = []
        for label in request["labels"]:
            answer = self._run(image, self.rules["task_detections"], label)
            for box in answer.get("bboxes", []):
                found.append({"label": label, "score": 1.0, "box": normalized_box(box, width, height)})
        return {"detections": found}

    def tags_of(self, image, request):
        # Dense region captions, reduced to their labels: what is in the
        # picture, once each, scored 1.
        answer = self._run(image, self.rules["task_tags"])
        seen = []
        for label in answer.get("labels", []):
            if label not in seen:
                seen.append(label)
        return {"tags": [{"tag": label, "score": 1.0} for label in seen[: request["limit"]]]}

    def captions_of(self, image, request):
        task = self.rules["task_caption_" + request["detail"]]
        return {"caption": str(self._run(image, task)).strip()}


class Dinov2Runner:
    """DINOv2: a picture, or parts of one, as vectors that say how it
    looks. Answers `embeddings`."""

    def __init__(self, model_dir, rules):
        check_version("transformers", TRANSFORMERS_VERSION)
        import torch
        import transformers

        transformers.utils.logging.disable_progress_bar()
        self.torch = torch
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        # The Pillow processor is named on purpose. AutoImageProcessor picks
        # a class that needs torchvision, which the serve environment does
        # not install, so the server would fail as it starts.
        self.processor = transformers.BitImageProcessorPil.from_pretrained(model_dir, local_files_only=True)
        self.model = transformers.Dinov2Model.from_pretrained(
            model_dir, use_safetensors=True, local_files_only=True, dtype=torch.float32
        ).to(self.device)
        # The color the processor subtracts as its mean, so the padding
        # around a crop normalizes to zero.
        self.padding = tuple(round(channel * 255) for channel in self.processor.image_mean)

    def _embed(self, crops):
        """One unit-length vector, as a list, per Pillow image."""
        if not crops:
            # The processor turns no images into a tensor the model cannot take.
            return []
        size = {"height": DINOV2_INPUT_SIZE, "width": DINOV2_INPUT_SIZE}
        inputs = self.processor(images=crops, do_center_crop=False, size=size, return_tensors="pt").to(self.device)
        with self.torch.no_grad():
            pooled = self.model(**inputs).pooler_output
        return self.torch.nn.functional.normalize(pooled, dim=-1).tolist()

    def embeddings_of(self, image, request):
        # The rules turned "no boxes" into one box over the whole image.
        width, height = image.size
        crops = [
            padded_square(image.crop(box_pixels(box, width, height, index)), self.padding)
            for index, box in enumerate(request["boxes"])
        ]
        return {"embeddings": self._embed(crops)}


RUNNERS = {"Wd14Runner": Wd14Runner, "Florence2Runner": Florence2Runner, "Dinov2Runner": Dinov2Runner}


class Server:
    """The loaded runner, its family, and a lock, because the model runs one
    request at a time."""

    def __init__(self, model_dir):
        names = os.listdir(model_dir)
        try:
            self.rules = family_of(names, read_config(model_dir))
        except ValueError as err:
            fail(str(err))
        # Never fetch anything while serving. Set before transformers and
        # huggingface_hub are imported, since they read it at import time.
        os.environ["HF_HUB_OFFLINE"] = "1"
        self.runner = RUNNERS[self.rules["runner"]](model_dir, self.rules)
        self.lock = threading.Lock()

    def answer(self, route, request, sock):
        """The reply for a checked request on a route, or None when the
        client hung up before the model ran."""
        with self.lock:
            if client_gone(sock):
                return None
            image = open_image(request["image"])
            method = getattr(self.runner, route + "_of")
            return method(image, request)

    def warm_up(self):
        """One request on the family's first route, against a small image
        the server draws in memory. A model that loads but cannot run
        fails here, before the port opens."""
        from PIL import Image, ImageDraw

        image = Image.new("RGB", (64, 64), (255, 255, 255))
        ImageDraw.Draw(image).rectangle((16, 16, 48, 48), fill=(0, 0, 0))
        png = io.BytesIO()
        image.save(png, format="PNG")
        route, body = warm_up_request(self.rules, base64.b64encode(png.getvalue()).decode("ascii"))
        self.answer(route, check_request(self.rules, route, body), None)


class Handler(BaseHTTPRequestHandler):
    server_state = None

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
            self.send_json(200, {"status": "ok", "routes": route_paths(self.server_state.rules)})
        else:
            self.send_error_json(404, f"{self.path} is not a route this server has.")

    def read_body(self):
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
        route = route_of_path(self.path)
        if route is None:
            answered = join_names(route_paths(self.server_state.rules))
            self.send_error_json(404, f"{self.path} is not a route this server has. It answers {answered}.")
            return
        try:
            request = check_request(self.server_state.rules, route, self.read_body())
            reply = self.server_state.answer(route, request, self.connection)
            if reply is None:
                # The client hung up; there is nobody to answer.
                return
        except RequestError as err:
            self.send_error_json(err.status, str(err))
            return
        except Exception as err:  # noqa: BLE001
            # Without a reply the caller would see only "socket hang up".
            self.send_error_json(500, f"The model failed: {err}")
            return
        try:
            self.send_json(200, reply)
        except (BrokenPipeError, ConnectionResetError):
            return


def main():
    args = parse_args()
    # Load and run once before binding the port. `agency local serve`
    # treats a refused connection as "still loading" and any answer as
    # "ready", so the port must stay closed until the model can answer.
    Handler.server_state = Server(args.model)
    Handler.server_state.warm_up()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
