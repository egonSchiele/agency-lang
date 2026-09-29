"""A stand-in for the trainer: prints the JSON lines a real run prints and
writes an empty adapter, or fails, as the environment says. Tests point
the Python at a shell script that runs this. When FAKE_TRAINER_LOG is
set, every run appends its arguments to that file, so a test can tell
whether anything ran."""

import json
import os
import sys
import time

args = sys.argv[1:]
out = next(arg.split("=", 1)[1] for arg in args if arg.startswith("--out="))
mode = os.environ.get("FAKE_TRAINER", "ok")
log = os.environ.get("FAKE_TRAINER_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps(args) + "\n")


def emit(**fields):
    print(json.dumps(fields), flush=True)


if mode == "refuse":
    print("steps must be from 1 to 20000. Got 0.", file=sys.stderr)
    sys.exit(1)
emit(event="start", images=4)
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
if mode == "hang-after-done":
    time.sleep(60)
