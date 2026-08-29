import json
import os
import sys

MAX_ENTRIES = 12
MAX_BYTES = 16 * 1024


def split(data):
    return [data[i:i + MAX_BYTES] for i in range(0, len(data), MAX_BYTES)] or [b""]


def lay_out(blobs, root):
    """Write blobs under root in a tree of fixed depth: leaf directories hold
    up to MAX_ENTRIES chunk files, branch directories up to MAX_ENTRIES
    subdirectories, and no data sits beside a subdirectory. File names carry
    the blob index, so a sorted walk reads them back in order."""
    depth = 0
    capacity = MAX_ENTRIES
    while capacity < len(blobs):
        capacity *= MAX_ENTRIES
        depth += 1
    for index, blob in enumerate(blobs):
        parts = []
        leaf = index // MAX_ENTRIES
        for _ in range(depth):
            parts.append(f"d{leaf % MAX_ENTRIES:02d}")
            leaf //= MAX_ENTRIES
        directory = os.path.join(root, *reversed(parts))
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, f"c{index:07d}.bin"), "wb") as f:
            f.write(blob)


def pack(src, dst):
    manifest = []
    chunks = []
    for dirpath, _dirs, files in os.walk(src):
        for name in sorted(files):
            full = os.path.join(dirpath, name)
            with open(full, "rb") as f:
                parts = split(f.read())
            manifest.append({"path": os.path.relpath(full, src), "parts": len(parts)})
            chunks.extend(parts)
    os.makedirs(dst, exist_ok=True)
    lay_out(split(json.dumps(manifest).encode()), os.path.join(dst, "manifest"))
    lay_out(chunks, os.path.join(dst, "data"))


if __name__ == "__main__":
    pack(sys.argv[1], sys.argv[2])
