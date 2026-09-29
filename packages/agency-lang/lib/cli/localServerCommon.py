"""What every local model server script shares. Imported by the speech and
image servers through sys.path, since they run as plain scripts. Nothing
here may import a model library.
"""

import base64
import binascii
import os
import select
import socket
import sys


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def client_gone(sock):
    """True when the client has closed its side of the connection. Passing
    None, as a warm-up does, means nobody can hang up, so False."""
    if sock is None:
        return False
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


class ImagePathError(ValueError):
    """A request named an image the server will not read. The message says
    why."""


# What a request may name as an image. The extension is checked, not the
# bytes: Pillow decides what the file is when it opens it, and refuses
# anything else.
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif")

# A comic page scanned at 600 dpi is under 20 MB. Larger than this is not
# an image a request should be pointing a model at.
MAX_IMAGE_BYTES = 50_000_000


def check_image_path(path):
    """The absolute path of a regular image file a request named. Raises
    ImagePathError for anything else: a relative path, a symlink at any
    component, a directory, a missing file, another extension, or a file
    over MAX_IMAGE_BYTES. The server reads the file once, after this; it
    never lists a directory and never writes."""
    if not isinstance(path, str) or path == "":
        raise ImagePathError("image must be the absolute path of an image file.")
    if not os.path.isabs(path):
        raise ImagePathError(f"image must be an absolute path. Got {path!r}.")
    prefix = ""
    for part in path.split(os.sep):
        prefix = os.path.join(prefix, part) if prefix else os.sep
        if os.path.islink(prefix):
            raise ImagePathError(f"{path} goes through a symlink at {prefix}, which this server does not follow.")
    if not os.path.isfile(path):
        raise ImagePathError(f"{path} is not a file.")
    if not path.lower().endswith(IMAGE_EXTENSIONS):
        raise ImagePathError(
            f"{path} is not an image this server reads. It reads {', '.join(IMAGE_EXTENSIONS)}."
        )
    size = os.path.getsize(path)
    if size > MAX_IMAGE_BYTES:
        raise ImagePathError(f"{path} is {size:,} bytes; this server reads images up to {MAX_IMAGE_BYTES:,}.")
    return path


def read_image_bytes(path):
    """The bytes of an image `check_image_path` accepted, read through a
    descriptor that refuses to follow a link at the final name."""
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as f:
        return f.read()


class ImageDataError(ValueError):
    """A request carried an image the server will not decode. The message
    says why."""


def base64_length(size):
    """How many characters base64 turns `size` bytes into."""
    return 4 * ((size + 2) // 3)


def image_bytes_of(value):
    """The bytes of an image a request sent as base64. Raises
    ImageDataError for anything that is not base64 of at most
    MAX_IMAGE_BYTES bytes. A request never names a path: the stdlib reads
    the file after the user approved it and sends what it read, so the
    server opens no file a request chose. Pillow decides later whether
    the bytes are an image."""
    if not isinstance(value, str) or value == "":
        raise ImageDataError("image must be the image's bytes as base64.")
    if len(value) > base64_length(MAX_IMAGE_BYTES):
        raise ImageDataError(f"image is over {MAX_IMAGE_BYTES:,} bytes; this server reads images up to that size.")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise ImageDataError("image is not valid base64.")
