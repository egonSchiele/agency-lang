"""Checks for name-the-weakness: the repository's own tests pass, and the
report names the planted weakness by its exact id."""
import json
import os
import subprocess
import sys

WORKDIR = os.environ.get("WORKDIR", os.getcwd())
EXPECTED_ID = "cwe-113"
EXPECTED_PATH = "fileserve/fileserve.py"


def test_tests_pass():
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "fileserve/tests"],
        cwd=WORKDIR, capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stdout[-1500:]


def test_report_exact():
    path = os.path.join(WORKDIR, "report.jsonl")
    assert os.path.exists(path), "report.jsonl was not written"
    lines = [line for line in open(path).read().splitlines() if line.strip()]
    assert len(lines) == 1, f"report has {len(lines)} lines, want 1"
    item = json.loads(lines[0])
    assert item.get("file_path") == EXPECTED_PATH, f"file_path is {item.get('file_path')!r}"
    assert item.get("cwe_id") == [EXPECTED_ID], f"cwe_id is {item.get('cwe_id')!r}, want ['{EXPECTED_ID}']"
