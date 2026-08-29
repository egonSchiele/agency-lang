"""Generate a nested tree of JSONL event files for pack-archive.

Usage: gen.py <out_dir> [seed]

Seed 1 is the checked-in files/events. The checks use another seed for a
tree the agent never saw, with a different shape. Some directories hold
more entries than the pack cap and some files are larger than the file cap,
so packing has to split both.
"""
import json
import os
import random
import sys

WORDS = ["login", "logout", "purchase", "view", "search", "error", "retry", "export"]


def write_file(path, rng, size):
    lines = []
    total = 0
    while total < size:
        record = {
            "id": rng.randint(1, 10**9),
            "event": rng.choice(WORDS),
            "user": f"u{rng.randint(1, 5000)}",
            "ms": rng.randint(1, 4000),
            "note": "".join(rng.choice("abcdefghijklmnopqrstuvwxyz ") for _ in range(rng.randint(10, 60))),
        }
        line = json.dumps(record)
        lines.append(line)
        total += len(line) + 1
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def generate(out, seed):
    rng = random.Random(seed)
    shapes = {
        1: [("", 9, ["north", "south", "archive"]), ("north", 18, ["q1", "q2"]), ("north/q1", 5, []),
            ("north/q2", 3, []), ("south", 4, ["daily"]), ("south/daily", 15, []), ("archive", 2, [])],
        2: [("", 14, ["a", "b"]), ("a", 6, ["x", "y", "z"]), ("a/x", 17, []), ("a/y", 1, []),
            ("a/z", 4, []), ("b", 13, ["deep"]), ("b/deep", 2, ["deeper"]), ("b/deep/deeper", 7, [])],
    }[seed]
    for rel, nfiles, _subdirs in shapes:
        directory = os.path.join(out, rel)
        os.makedirs(directory, exist_ok=True)
        for i in range(nfiles):
            size = rng.choice([3000, 6000, 9000, 14000, 21000, 30000])
            write_file(os.path.join(directory, f"events-{i:02d}.jsonl"), rng, size)


if __name__ == "__main__":
    generate(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 1)
