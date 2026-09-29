"""A stand-in for the trainer: prints the JSON lines a real run prints and
writes an empty adapter, or fails, as the environment says. Tests point
`pythonPath` at a shell script that runs this."""

import json
import os
import sys
import time

args = sys.argv[1:]
out = args[args.index("--out") + 1]
mode = os.environ.get("FAKE_TRAINER", "ok")


def emit(**fields):
    print(json.dumps(fields), flush=True)


if mode == "refuse":
    print("steps must be from 1 to 20000. Got 0.", file=sys.stderr)
    sys.exit(1)
emit(event="estimate", images=4, steps=20, estimatedMinutes=0.3)
if "--estimate-only" in args:
    sys.exit(0)
emit(event="cached", images=8)
with open(out + ".partial", "wb") as f:
    f.write(b"partial")
if mode == "hang":
    time.sleep(60)
if mode == "die":
    print("the GPU ran out of memory", file=sys.stderr)
    sys.exit(1)
emit(event="step", step=20, loss=0.04, secondsPerStep=0.5)
sample = os.path.join(os.path.dirname(out), "step_0020.png")
open(sample, "wb").write(b"png")
emit(event="sample", path=sample)
os.replace(out + ".partial", out)
emit(event="done", path=out, minutes=0.2)
