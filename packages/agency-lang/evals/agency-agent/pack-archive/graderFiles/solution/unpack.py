import json
import os
import shutil
import sys


def read_blobs(root):
    """The blobs lay_out wrote, in index order: names are zero padded, so a
    sorted walk is the original order."""
    paths = []
    for dirpath, _dirs, files in os.walk(root):
        paths.extend(os.path.join(dirpath, name) for name in files)
    for path in sorted(paths):
        with open(path, "rb") as f:
            yield f.read()


def unpack(packed):
    manifest = json.loads(b"".join(read_blobs(os.path.join(packed, "manifest"))))
    chunks = read_blobs(os.path.join(packed, "data"))
    files = [(entry["path"], b"".join(next(chunks) for _ in range(entry["parts"]))) for entry in manifest]
    for name in os.listdir(packed):
        full = os.path.join(packed, name)
        shutil.rmtree(full) if os.path.isdir(full) else os.remove(full)
    for rel, data in files:
        full = os.path.join(packed, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(data)


if __name__ == "__main__":
    unpack(sys.argv[1])
