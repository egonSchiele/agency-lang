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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mlxSpeechRules import (  # noqa: E402
    FAMILIES,
    FORMATS,
    MLX_AUDIO_VERSION,
    MODEL_VOICES,
    UNSERVED_FAMILIES,
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


class Speaker:
    """The loaded model, its family, its speakers, and a lock, because MLX
    runs one computation at a time."""

    def __init__(self, model_dir):
        from mlx_audio.tts.utils import load_model

        config = read_config(model_dir)
        self.family = family_of(config)
        self.rules = FAMILIES.get(self.family)
        if self.rules is None:
            raise RequestError(
                f"{model_dir} holds {UNSERVED_FAMILIES[self.family]}, which this version does not serve yet."
            )
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
        Handler.speaker = Speaker(args.model)
        Handler.speaker.warm_up()
    except RequestError as err:
        fail(str(err))
    Handler.served_name = args.model
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
