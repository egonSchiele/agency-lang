#!/bin/sh
# Stands in for a Python: ignores the trainer script argument and runs the
# fake trainer with the rest.
shift
exec python3 "$(dirname "$0")/fakeTrainer.py" "$@"
