"""An OpenAI-style /v1/embeddings server for one MLX embedding model.

Started by `agency local serve --embedding <model>`. Loads the model once
with mlx-lm, then answers:

  POST /v1/embeddings   {"model": ..., "input": "text" | ["text", ...], "dimensions": n?}
  GET  /v1/models
  GET  /health

The embedding is the final hidden state of the last token, L2-normalized.
That is what the Qwen3 Embedding family expects, and it is what any causal
language model mlx-lm can load gives. Encoder models are not loadable by
mlx-lm and are not supported here.
"""

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mlx.core as mx
from mlx_lm import load


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="model directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--max-length",
        type=int,
        default=8192,
        help="longest input in tokens; longer inputs are cut, keeping the end token",
    )
    return parser.parse_args()


class Embedder:
    """The loaded model and a lock, because MLX runs one computation at a
    time and two threads sharing the model would only interleave."""

    def __init__(self, model_dir, max_length):
        self.model, self.tokenizer = load(model_dir)
        self.max_length = max_length
        self.lock = threading.Lock()

    def embed(self, text, dimensions):
        # The tokenizer appends the model's end token itself; pooling reads
        # that position. When cutting a long input, keep it.
        tokens = self.tokenizer.encode(text)
        if len(tokens) > self.max_length:
            tokens = tokens[: self.max_length - 1] + tokens[-1:]
        hidden = self.model.model(mx.array(tokens)[None])
        vector = hidden[0, -1].astype(mx.float32)
        if dimensions is not None:
            vector = vector[:dimensions]
        vector = vector / mx.maximum(mx.linalg.norm(vector), 1e-6)
        mx.eval(vector)
        return vector.tolist(), len(tokens)

    def embed_all(self, texts, dimensions):
        with self.lock:
            return [self.embed(text, dimensions) for text in texts]


class Handler(BaseHTTPRequestHandler):
    embedder = None
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
        if self.path != "/v1/embeddings":
            self.send_error_json(
                404,
                f"{self.path} is not a route this server has. It serves embeddings only; "
                "chat requests go to a chat model.",
            )
            return
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.send_error_json(400, "Request body is not JSON.")
            return
        inputs = body.get("input")
        if isinstance(inputs, str):
            inputs = [inputs]
        if not isinstance(inputs, list) or not inputs or not all(isinstance(t, str) for t in inputs):
            self.send_error_json(400, "input must be a string or a non-empty list of strings.")
            return
        dimensions = body.get("dimensions")
        if dimensions is not None and (not isinstance(dimensions, int) or dimensions <= 0):
            self.send_error_json(400, "dimensions must be a positive integer.")
            return
        results = self.embedder.embed_all(inputs, dimensions)
        total = sum(count for _, count in results)
        self.send_json(
            200,
            {
                "object": "list",
                "model": self.served_name,
                "data": [
                    {"object": "embedding", "index": i, "embedding": vector}
                    for i, (vector, _) in enumerate(results)
                ],
                "usage": {"prompt_tokens": total, "total_tokens": total},
            },
        )


def main():
    args = parse_args()
    # Load before binding the port. `agency local serve` treats a refused
    # connection as "still loading" and any answer as "ready", so the port
    # must stay closed until the model can answer.
    Handler.embedder = Embedder(args.model, args.max_length)
    Handler.served_name = args.model
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
