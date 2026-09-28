"""What every local model server script shares. Imported by the speech and
image servers through sys.path, since they run as plain scripts. Nothing
here may import a model library.
"""

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
