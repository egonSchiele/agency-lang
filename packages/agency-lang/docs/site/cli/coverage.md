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

### Cleaning collected data

```
agency coverage clean
```

Removes the `.coverage/` directory.

## Configuration

The output directory can be configured in `agency.json`:

```json
{
  "coverage": {
    "outDir": ".coverage"
  }
}
```

Defaults to `.coverage` if not set.

## Environment variables

These are normally set automatically by the `--coverage` flag, but you can also set them manually to enable coverage in any process running compiled Agency code:

- `AGENCY_COVERAGE` — when set (to any non-empty value), the runtime collects step hits and writes a JSON file to the configured output directory on process exit.
- `AGENCY_COVERAGE_OUTDIR` — overrides the output directory for the JSON files. Defaults to `.coverage`. Should be an absolute path when subprocesses with different working directories are involved (the `--coverage` flag handles this for you).

## How it works

- Every step the Agency runtime executes calls into a `CoverageCollector`. Hits are keyed by `${moduleId}:${scopeName}` -> `{ stepPath: true }`.
- Modules whose path lives under a `node_modules` directory are excluded — only user-authored `.agency` files in your workspace are tracked.
- Each process writes a `cov-{pid}-{uuid}.json` file on exit so concurrent test workers do not collide.
- `agency coverage report` merges all `cov-*.json` files in the output directory, compiles each target `.agency` file to read its `__sourceMap` export, and computes per-file/per-line coverage.
