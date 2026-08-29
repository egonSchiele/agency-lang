import csv
import datetime as dt
import os
import re

TODAY = dt.date(2025, 9, 12)
LEVELS = ["CRITICAL", "ERROR", "WARNING", "INFO"]
week_start = TODAY - dt.timedelta(days=TODAY.weekday())
quarter_start = dt.date(TODAY.year, 3 * ((TODAY.month - 1) // 3) + 1, 1)
WINDOWS = [
    ("today", TODAY, TODAY),
    ("last_14_days", TODAY - dt.timedelta(days=13), TODAY),
    ("week_to_date", week_start, TODAY),
    ("quarter_to_date", quarter_start, TODAY),
    ("total", None, None),
]

counts = {}
for name in os.listdir("logs"):
    m = re.match(r".*-(\d{4})(\d{2})(\d{2})\.log$", name)
    if not m:
        continue
    date = dt.date(*map(int, m.groups()))
    with open(os.path.join("logs", name)) as f:
        for line in f:
            parts = line.split()
            if len(parts) > 1 and parts[1] in LEVELS:
                counts[(date, parts[1])] = counts.get((date, parts[1]), 0) + 1

with open("summary.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["period", "level", "count"])
    for period, lo, hi in WINDOWS:
        for level in LEVELS:
            w.writerow([period, level, sum(
                n for (d, l), n in counts.items() if l == level and (lo is None or lo <= d <= hi)
            )])
