import json
import os
import shutil
import sys

MAX_ENTRIES = 12
MAX_BYTES = 16 * 1024


def pack(src, dst):
    os.makedirs(dst, exist_ok=True)
    chunks = []  # (original relative path, chunk index, bytes)
    for dirpath, _dirs, files in os.walk(src):
        for name in sorted(files):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, src)
            with open(full, "rb") as f:
                data = f.read()
            for i in range(0, max(len(data), 1), MAX_BYTES):
                chunks.append((rel, i // MAX_BYTES, data[i:i + MAX_BYTES]))
    manifest = []
    # Place chunks in numbered subdirectories, each holding at most
    # MAX_ENTRIES - 1 files, nested so no directory exceeds the cap.
    per_dir = MAX_ENTRIES - 1
    for index, (rel, part, data) in enumerate(chunks):
        leaf = index // per_dir
        path_parts = []
        n = leaf
        while True:
            path_parts.append(f"d{n % per_dir:02d}")
            n //= per_dir
            if n == 0:
                break
        directory = os.path.join(dst, *reversed(path_parts))
        os.makedirs(directory, exist_ok=True)
        chunk_name = f"c{index % per_dir:02d}.bin"
        with open(os.path.join(directory, chunk_name), "wb") as f:
            f.write(data)
        manifest.append({"path": rel, "part": part, "chunk": os.path.relpath(os.path.join(directory, chunk_name), dst)})
    with open(os.path.join(dst, "manifest.json"), "w") as f:
        json.dump(manifest, f)


if __name__ == "__main__":
    pack(sys.argv[1], sys.argv[2])
