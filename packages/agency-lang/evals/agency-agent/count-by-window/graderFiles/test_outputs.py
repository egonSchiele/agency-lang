"""Checks for count-by-window. The expected CSV comes from gen.py with the
seed that produced files/logs, so it never lives in the repo as an answer."""
import csv
import os
import subprocess
import sys
import tempfile

WORKDIR = os.environ.get("WORKDIR", os.getcwd())
HERE = os.path.dirname(os.path.abspath(__file__))
PERIODS = ["today", "last_14_days", "week_to_date", "quarter_to_date", "total"]
LEVELS = ["CRITICAL", "ERROR", "WARNING", "INFO"]


def expected_rows():
    with tempfile.TemporaryDirectory() as tmp:
        csv_path = os.path.join(tmp, "expected.csv")
        subprocess.run(
            [sys.executable, os.path.join(HERE, "gen.py"), os.path.join(tmp, "logs"), csv_path, "1"],
            check=True,
        )
        with open(csv_path, newline="") as f:
            return list(csv.reader(f))


def actual_rows():
    path = os.path.join(WORKDIR, "summary.csv")
    assert os.path.exists(path), "summary.csv was not written"
    with open(path, newline="") as f:
        return [row for row in csv.reader(f) if row]


def test_header_and_order():
    rows = actual_rows()
    assert rows[0] == ["period", "level", "count"], f"header is {rows[0]}"
    got = [(row[0], row[1]) for row in rows[1:]]
    want = [(p, l) for p in PERIODS for l in LEVELS]
    assert got == want, f"row order is {got[:6]}..."


def test_summary_exact():
    want = expected_rows()
    got = actual_rows()
    by_key = {(r[0], r[1]): r[2] for r in got[1:] if len(r) == 3}
    diffs = [
        f"{p},{l}: got {by_key.get((p, l), 'missing')} want {c}"
        for p, l, c in want[1:]
        if by_key.get((p, l)) != c
    ]
    assert not diffs, "\n".join(diffs)
