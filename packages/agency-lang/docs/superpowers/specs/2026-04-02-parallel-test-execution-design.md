# Parallel Test Execution

## Summary

Enable parallel execution of agency tests (`pnpm run test:agency`) with a user-specified concurrency level, controlled via a CLI flag and/or `agency.json` config.

## Problem

Agency tests run sequentially. With 90+ test files, this is slow. The primary blocker for parallelism is that `executeNode` writes to hardcoded filenames (`__evaluate.js`, `__evaluate.json`), causing file collisions if multiple tests run concurrently. Similarly, `executeJudge` writes to hardcoded `__judge.js` and `__judge_evaluate.js` / `__judge_evaluate.json` filenames.

## Scope

This spec covers the `test` command for `.test.json`-based agency tests only. The `testTs` code path (JavaScript integration tests via `--js`) is out of scope — it has its own hardcoded filenames (`__result.json`) but is a separate concern.

## Design

### 1. Unique evaluate filenames

`executeNode` in `lib/cli/util.ts` currently writes to `__evaluate.js` and reads from `__evaluate.json`. Change these to be derived from the agency file path:

```
tests/agency/threads/simple.agency
  → tests/agency/threads/simple.evaluate.js
  → tests/agency/threads/simple.evaluate.json
```

This requires changes in two places:
- **`executeNode` in `lib/cli/util.ts`** — derive the evaluate script filename and results filename from the agency file path.
- **`lib/templates/cli/evaluate.mustache`** — the template currently hardcodes `writeFileSync("__evaluate.json", ...)`. Add a `resultsFilename` template parameter so the output filename is dynamic. Run `pnpm run templates` after modifying.

The compiled `.js` output already uses the agency filename (`agencyFile.replace(".agency", ".js")`), so it's already unique and requires no changes.

**`executeJudge`** has the same problem with `__judge.js`, `__judge_evaluate.js`, and `__judge_evaluate.json`. Apply the same naming scheme:

```
tests/agency/threads/simple.agency
  → tests/agency/threads/simple.judge.js
  → tests/agency/threads/simple.judge_evaluate.js
  → tests/agency/threads/simple.judge_evaluate.json
```

The `judgeEvaluate.mustache` template hardcodes `__judge_evaluate.json` and needs a `resultsFilename` template parameter, same as `evaluate.mustache`. Run `pnpm run templates` after modifying.

**Cleanup:** After each test file completes (in a `finally` block to ensure cleanup even on error), delete the generated evaluate and judge temp files. Add `*.evaluate.js`, `*.evaluate.json`, `*.judge.js`, `*.judge_evaluate.js`, and `*.judge_evaluate.json` patterns under `tests/` to `.gitignore` as a safety net.

**Shared dependency compilation:** `compile()` uses a module-level `compiledFiles` Set to skip already-compiled files. Since `compile()` is synchronous and JS is single-threaded, the Set guard works correctly even with async parallelism — one call compiles and adds to the set before yielding; subsequent calls skip. No race condition.

**Tarsec global state:** The tarsec parser library has global state, which means you cannot parallelize parsing multiple files at the same time. This is not an issue here because `compile()` (which calls tarsec) is synchronous and runs in the parent process — only one compile runs at a time. The child processes spawned by `execFile` only execute already-compiled JS and never touch tarsec.

### 2. Async executeNode

`executeNode` is currently fully synchronous — it uses `execFileSync` to run the evaluate script. Wrapping synchronous blocking calls in `Promise.all` won't parallelize anything because `execFileSync` blocks the Node.js event loop.

To get real parallelism, `executeNode` must become async. Specifically, replace `execFileSync("node", [evaluateFile])` with the promisified `child_process.execFile`. The `compile()` call before it is synchronous but fast (no external process spawn), so it can remain sync.

The current code uses `stdio: "inherit"`, which pipes child process output directly to the parent's console. This is incompatible with both async execution and buffered output. When switching to async `execFile`, remove `stdio: "inherit"` and instead capture stdout/stderr from the resolved promise result. The captured output feeds into the buffered logger (Section 4). The same applies to `executeJudge`, which also uses `stdio: "inherit"`.

This also means `runSingleTest` must become async (it already returns a value, just needs to await the node execution).

### 3. Concurrency limiter

Add a `runWithConcurrency` utility function:

```ts
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void>
```

This maintains a pool of up to `concurrency` in-flight promises, starting the next task as each one completes. No external dependencies needed.

**Error handling:** `runWithConcurrency` is fault-tolerant. If one test throws, the error is captured and the remaining queued and in-flight tests continue to run. Errors are collected and the overall stats reflect failures, consistent with current sequential behavior.

**Parallelism boundary:** Parallelism is at the **file level** — each `.test.json` file runs concurrently, but test cases within a single file still run sequentially. This is because `executeNode` calls `compile`, and multiple test cases in the same file share the same `.agency` source and compiled `.js` output.

The recursive structure of `test()` needs to be refactored: first collect all `.test.json` paths, then run them through the concurrency pool. Currently `test()` recurses into directories and processes files inline — this becomes a two-phase approach: collect, then execute.

### 4. Buffered output

When running in parallel (concurrency > 1), each test file's output is collected into an array of log lines instead of calling `console.log` directly. Once all test cases for a given `.test.json` file complete, the buffered lines are flushed to the console in one go.

This requires passing a logger function through `runSingleTest` and the per-file test logic in `test()`.

Output is always buffered regardless of concurrency level. This keeps the implementation simple — no special-casing for sequential mode.

### 5. CLI flag and config

The `test` command in `scripts/agency.ts` gets a `--parallel` / `-p` option accepting a number:

```
pnpm run test:agency -- --parallel 4
```

`agency.json` gets a `test.parallel` field as a fallback:

```json
{
  "test": {
    "parallel": 4
  }
}
```

Precedence: CLI flag > `agency.json` > default (1).

When `parallel` is 1, behavior is identical to today — sequential execution, direct console output, no buffering.

## Files to change

- `lib/cli/util.ts` — derive evaluate and judge filenames from agency file path, make `executeNode` async (promisified `execFile`)
- `lib/cli/test.ts` — add `runWithConcurrency`, buffered output, refactor `test()` into collect-then-execute, make `runSingleTest` async, accept `parallel` parameter, clean up temp files in `finally` blocks
- `lib/templates/cli/evaluate.mustache` — add `resultsFilename` template parameter (run `pnpm run templates` after)
- `lib/templates/cli/judgeEvaluate.mustache` — add `resultsFilename` template parameter (run `pnpm run templates` after)
- `scripts/agency.ts` — add `--parallel` CLI option to test command
- `lib/config.ts` — add `test.parallel` to `AgencyConfig`
- `.gitignore` — add `tests/**/*.evaluate.js`, `tests/**/*.evaluate.json`, `tests/**/*.judge.js`, `tests/**/*.judge_evaluate.js`, `tests/**/*.judge_evaluate.json`

## Testing

- Verify sequential mode (parallel=1) produces identical results to current behavior
- Verify parallel mode runs tests concurrently and produces correct results
- Verify output from parallel tests is not interleaved (each file's output appears as a contiguous block)
- Verify CLI flag overrides config value
- Unit test for `runWithConcurrency`: respects concurrency limit, handles errors without aborting other tasks
- Verify temp files are cleaned up after test run
