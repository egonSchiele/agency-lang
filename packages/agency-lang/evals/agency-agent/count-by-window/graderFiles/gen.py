"""Generate the log tree for count-by-window and the expected summary.

Usage: gen.py <logs_dir> <expected_csv> [seed]

Deterministic for a seed, so the checked-in files/logs and the expected
CSV the checks compute at grade time come from the same call. Dates are
placed on both sides of every window edge: 14 days back, the Monday of the
ISO week, the first of the quarter, and the day after "today".
"""
import csv
import datetime as dt
import random
import sys

TODAY = dt.date(2025, 9, 12)
LEVELS = ["CRITICAL", "ERROR", "WARNING", "INFO"]
SOURCES = ["api", "db", "worker", "auth"]
MESSAGES = [
    "request completed", "connection reset by peer", "retrying job", "cache miss",
    "token expired", "slow query", "disk usage above threshold", "user login",
]


def edge_dates():
    week_start = TODAY - dt.timedelta(days=TODAY.weekday())
    quarter_start = dt.date(TODAY.year, 3 * ((TODAY.month - 1) // 3) + 1, 1)
    fourteen = TODAY - dt.timedelta(days=13)
    edges = [week_start, quarter_start, fourteen, TODAY]
    dates = set()
    for edge in edges:
        for delta in (-1, 0, 1):
            dates.add(edge + dt.timedelta(days=delta))
    dates.add(TODAY + dt.timedelta(days=1))
    return dates


def generate(logs_dir, expected_csv, seed):
    rng = random.Random(seed)
    import os
    os.makedirs(logs_dir, exist_ok=True)
    dates = edge_dates()
    start = TODAY - dt.timedelta(days=69)
    for i in range(70):
        if rng.random() < 0.45:
            dates.add(start + dt.timedelta(days=i))
    counts = {}
    for date in sorted(dates):
        for source in SOURCES:
            if rng.random() < 0.6:
                continue
            lines = []
            for _ in range(rng.randint(20, 80)):
                level = rng.choices(LEVELS, weights=[1, 3, 5, 12])[0]
                hour, minute, second = rng.randint(0, 23), rng.randint(0, 59), rng.randint(0, 59)
                msg = rng.choice(MESSAGES)
                lines.append(f"{date.isoformat()}T{hour:02d}:{minute:02d}:{second:02d} {level} {source}: {msg}")
                counts[(date, level)] = counts.get((date, level), 0) + 1
            name = f"{source}-{date.strftime('%Y%m%d')}.log"
            with open(os.path.join(logs_dir, name), "w") as f:
                f.write("\n".join(lines) + "\n")
    week_start = TODAY - dt.timedelta(days=TODAY.weekday())
    quarter_start = dt.date(TODAY.year, 3 * ((TODAY.month - 1) // 3) + 1, 1)
    windows = [
        ("today", TODAY, TODAY),
        ("last_14_days", TODAY - dt.timedelta(days=13), TODAY),
        ("week_to_date", week_start, TODAY),
        ("quarter_to_date", quarter_start, TODAY),
        ("total", None, None),
    ]
    with open(expected_csv, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["period", "level", "count"])
        for period, lo, hi in windows:
            for level in LEVELS:
                total = sum(
                    n for (date, lvl), n in counts.items()
                    if lvl == level and (lo is None or lo <= date <= hi)
                )
                writer.writerow([period, level, total])


if __name__ == "__main__":
    generate(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1)
