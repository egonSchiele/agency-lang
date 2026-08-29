#!/usr/bin/env bash
set -e
cp "$(dirname "$0")/fileserve.py" fileserve/fileserve.py
printf '{"file_path": "fileserve/fileserve.py", "cwe_id": ["cwe-113"]}\n' > report.jsonl
