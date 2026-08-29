#!/usr/bin/env bash
# Applies the reference solution to a workdir (cwd).
set -e
cp "$(dirname "$0")/summarize.py" summarize.py
python3 summarize.py
