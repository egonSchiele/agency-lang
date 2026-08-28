import json
import os
import shutil
import sys


def unpack(packed):
    with open(os.path.join(packed, "manifest.json")) as f:
        manifest = json.load(f)
    files = {}
    for entry in sorted(manifest, key=lambda e: (e["path"], e["part"])):
        with open(os.path.join(packed, entry["chunk"]), "rb") as f:
            files.setdefault(entry["path"], []).append(f.read())
    for name in os.listdir(packed):
        full = os.path.join(packed, name)
        shutil.rmtree(full) if os.path.isdir(full) else os.remove(full)
    for rel, parts in files.items():
        full = os.path.join(packed, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(b"".join(parts))


if __name__ == "__main__":
    unpack(sys.argv[1])
