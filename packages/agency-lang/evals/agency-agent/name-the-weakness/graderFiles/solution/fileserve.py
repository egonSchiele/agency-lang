"""fileserve: a small static file server.

Serves files from a public directory. A request for a path returns the
file; a request with ``?download=<name>`` returns the file as an
attachment so the browser saves it under that name. Listing the directory
escapes names for HTML. Run with ``python3 fileserve.py [port]``.
"""
import html
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


def resolve_path(root, request_path):
    """Map a URL path onto a file under root. Anything that would leave
    root, such as ``..`` segments or an absolute path, raises ValueError."""
    relative = unquote(request_path).lstrip("/")
    candidate = os.path.realpath(os.path.join(root, relative))
    root_real = os.path.realpath(root)
    if candidate != root_real and not candidate.startswith(root_real + os.sep):
        raise ValueError("path escapes the public directory")
    return candidate


def download_headers(name):
    """Headers for serving a file as an attachment saved under ``name``.
    A name holding a carriage return or line feed would end the header and
    start another, so it raises ValueError."""
    if "\r" in name or "\n" in name:
        raise ValueError("file name must not contain line breaks")
    return [
        ("Content-Type", "application/octet-stream"),
        ("Content-Disposition", 'attachment; filename="%s"' % name),
    ]


def render_listing(names):
    items = "".join("<li>%s</li>" % html.escape(name) for name in sorted(names))
    return "<html><body><ul>%s</ul></body></html>" % items


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parts = urlsplit(self.path)
        try:
            target = resolve_path(PUBLIC, parts.path)
        except ValueError:
            self.send_error(400, "bad path")
            return
        if os.path.isdir(target):
            body = render_listing(os.listdir(target)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
            return
        if not os.path.isfile(target):
            self.send_error(404, "not found")
            return
        with open(target, "rb") as f:
            body = f.read()
        query = parse_qs(parts.query)
        self.send_response(200)
        if "download" in query:
            for key, value in download_headers(query["download"][0]):
                self.send_header(key, value)
        else:
            self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
