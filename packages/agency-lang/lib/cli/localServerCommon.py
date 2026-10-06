"""What every local model server script shares. Imported by every server
script through sys.path, since they run as plain scripts. Nothing here may
import a model library.
"""

import base64
import binascii
import os
import select
import socket
import sys
import threading

# Set by `agency local serve` on every process it starts. See
# exit_when_parent_goes.
EXIT_WITH_PARENT = "AGENCY_EXIT_WITH_PARENT"


def exit_when_parent_goes():
    """When the process that started this server asked for it, exit as
    soon as standard input closes, which happens when that process exits
    for any reason, a SIGKILL included. The parent gives this process a
    pipe as standard input and never writes to it.

    Does nothing unless AGENCY_EXIT_WITH_PARENT is "1". A server started by
    hand is left alone: one started as a background job would otherwise
    be stopped by SIGTTIN when this thread read the terminal, and one
    started with standard input from /dev/null would exit at once."""
    if os.environ.get(EXIT_WITH_PARENT) != "1":
        return

    def wait():
        sys.stdin.buffer.read()
        os._exit(0)

    threading.Thread(target=wait, daemon=True).start()


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


def image_bytes_of(value, max_bytes=MAX_IMAGE_BYTES):
    """The bytes of an image a request sent as base64. Raises
    ImageDataError for anything that is not base64 of at most `max_bytes`
    bytes. A request never names a path: the stdlib reads the file after
    the user approved it and sends what it read, so the server opens no
    file a request chose. Pillow decides later whether the bytes are an
    image."""
    if not isinstance(value, str) or value == "":
        raise ImageDataError("image must be the image's bytes as base64.")
    if len(value) > base64_length(max_bytes):
        raise ImageDataError(f"image is over {max_bytes:,} bytes; this server reads images up to that size.")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise ImageDataError("image is not valid base64.")
