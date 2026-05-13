# Coverage

Agency includes a step-coverage system that tracks which lines of your `.agency` source files were exercised by tests. Coverage records every step the runtime executes (function bodies, `if`/`else` arms, loop iterations, handlers, etc.) and produces summary, detail, or HTML reports.

## Quick start

Run any test command with `--coverage`:

```
agency test --coverage tests/
agency test js --coverage tests/
```

A summary report is printed after the tests finish:

```
Agency Coverage Report
======================
stdlib/array.agency                      100.0%  (76/76 steps)
stdlib/object.agency                     100.0%  (22/22 steps)
stdlib/math.agency                        33.3%  (2/6 steps)
────────────────────────────────────────────────────────────
Total                                     53.8%  (162/301 steps)
```

By default each `--coverage` invocation cleans the previous `.coverage/` data first. Pass `--accumulate` to merge into the existing dataset:

```
agency test --coverage tests/agency/binop.agency
agency test --coverage --accumulate tests/agency/handlers/
```

## Generating reports

Once coverage data has been collected, generate a report at any time:

```
agency coverage report stdlib/
agency coverage report --detail stdlib/
agency coverage report --html stdlib/
agency coverage report tests/agency/binop.agency
```

A target argument is required — it can be a directory (scanned recursively for `.agency` files) or a single `.agency` file.

### Options

- `--detail` — list uncovered line ranges per file.
- `--html` — write a self-contained HTML report to `.coverage/report/index.html` with annotated source for every file.
- `--threshold <percent>` — exit with code `1` when total coverage falls below the given value (0–100). Useful in CI to block merges that would drop coverage.
- `--per-file-threshold <percent>` — exit with code `1` when any individual file falls below the given value. Combine with `--threshold` to enforce both an overall minimum and a per-file minimum.

When a threshold is set, the report ends with either `✓ Coverage thresholds met` or one or more `✗` lines listing the failing files / overall percentage.

```
agency coverage report stdlib --threshold 80 --per-file-threshold 60
```

### Cleaning collected data

```
agency coverage clean
```

Removes the `.coverage/` directory.

## Configuration

All options can be set in `agency.json` so you don't have to repeat them on the command line:

```json
{
  "coverage": {
    "outDir": ".coverage",
    "threshold": 80,
    "perFileThreshold": 60,
    "exclude": [
      "examples/**",
      "stdlib/legacy/**",
      "**/*.generated.agency"
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `outDir` | string | Directory for collected coverage data. Defaults to `.coverage`. |
| `threshold` | number (0–100) | Overall coverage minimum. Equivalent to passing `--threshold`. |
| `perFileThreshold` | number (0–100) | Per-file coverage minimum. Equivalent to passing `--per-file-threshold`. |
| `exclude` | string[] | [picomatch](https://github.com/micromatch/picomatch) globs of source files to drop from reports and threshold checks. Both absolute and cwd-relative paths are matched, so you can write either form. |

CLI flags always override the corresponding config values for that single invocation.

## Environment variables

These are normally set automatically by the `--coverage` flag, but you can also set them manually to enable coverage in any process running compiled Agency code:

- `AGENCY_COVERAGE` — when set (to any non-empty value), the runtime collects step hits and writes a JSON file to the configured output directory on process exit.
- `AGENCY_COVERAGE_OUTDIR` — overrides the output directory for the JSON files. Defaults to `.coverage`. Should be an absolute path when subprocesses with different working directories are involved (the `--coverage` flag handles this for you).

## How it works

- Every step the Agency runtime executes calls into a `CoverageCollector`. Hits are keyed by `${moduleId}:${scopeName}` -> `{ stepPath: true }`.
- Modules whose path lives under a `node_modules` directory are excluded — only user-authored `.agency` files in your workspace are tracked.
- Each process writes a `cov-{pid}-{uuid}.json` file on exit so concurrent test workers do not collide.
- `agency coverage report` merges all `cov-*.json` files in the output directory, compiles each target `.agency` file to read its `__sourceMap` export, and computes per-file/per-line coverage.
