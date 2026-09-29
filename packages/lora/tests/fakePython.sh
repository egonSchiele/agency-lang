#!/bin/sh
# Stands in for a Python: ignores the trainer script argument and runs the
# fake trainer with the rest. The real script's argument parsing is tested
# on its own in trainerArgs.test.ts.
shift
exec python3 "$(dirname "$0")/fakeTrainer.py" "$@"
