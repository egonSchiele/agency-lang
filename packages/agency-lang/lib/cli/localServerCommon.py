"""What every local model server script shares. Imported by the speech,
image, and vision servers through sys.path, since they run as plain scripts. Nothing
here may import a model library.
"""

import base64
import binascii
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


class ImageDataError(ValueError):
    """A request carried an image the server will not decode. The message
    says why."""


# A comic page scanned at 600 dpi is under 20 MB. Larger than this is not
# an image a request should be sending a model. lib/stdlib/vision.ts
# refuses the same size before it sends anything.
MAX_IMAGE_BYTES = 50_000_000


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
