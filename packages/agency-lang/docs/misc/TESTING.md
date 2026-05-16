# Testing Guide

This document covers all the ways to write and run tests in the Agency language repo.
Note: All `agency` commands in this file should be run using `pnpm run agency`.

## Quick Reference

| Test Type | Location | Run Command |
|-----------|----------|-------------|
| Unit tests | `lib/**/*.test.ts` | `pnpm test` or `pnpm test:run` |
| Generator fixtures | `tests/typescriptGenerator/` | `pnpm test:run` |
| Preprocessor fixtures | `tests/typescriptPreprocessor/` | `pnpm test:run` |
| Agency execution tests | `tests/agency/` | `agency test tests/agency` |
| Multi-step JS tests | `tests/agency-js/` | `agency test js tests/agency-js` |

> The agency and agency-js suites can be run without an `OPENAI_API_KEY` by setting `AGENCY_USE_TEST_LLM_PROVIDER=1` — see [Deterministic LLM mode](#deterministic-llm-mode-no-api-key). This is what CI uses on every PR.

---

## 1. Unit Tests (Vitest)

Parser and generator unit tests live alongside their source files as `.test.ts` files.

**Examples:**
- `lib/parsers/literals.test.ts`
- `lib/parsers/assignment.test.ts`
- `lib/backends/agencyGenerator.test.ts`

**Writing a unit test:**

```typescript
import { describe, it, expect } from "vitest";
import { myParser } from "./myParser.js";

describe("myParser", () => {
  it("should parse a simple input", () => {
    const result = myParser("hello world");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ type: "text", value: "hello world" });
  });
});
```

Vitest globals (`describe`, `it`, `expect`) are available without imports since `globals: true` is set in `vitest.config.ts`.

**Run:**

```bash
pnpm test          # Watch mode
pnpm test:run      # Run once
```

---

## 2. TypeScript Generator Fixtures

Integration tests that verify the TypeScript code generator produces the expected output from Agency source code.

**Location:** `tests/typescriptGenerator/`

Each test is a pair of files:
- `example.agency` — Agency source code
- `example.mjs` — expected generated TypeScript output

**Test runner:** `lib/backends/typescriptGenerator.integration.test.ts`

The runner automatically discovers all `.agency` files that have a matching `.mjs` file, parses the Agency source, generates TypeScript, and compares against the `.mjs` fixture. Whitespace is normalized for comparison.

**Adding a new fixture:**

1. Create `tests/typescriptGenerator/mytest.agency` with the Agency code you want to test.
2. Run `make fixtures` to auto-generate the expected `.mjs` output.
3. Inspect the generated `.mjs` file to make sure it's correct.
4. Run `pnpm test:run` to verify the test passes.

**Regenerating all fixtures:**

```bash
make fixtures
```

This runs `pnpm run templates && pnpm run build` and then `node dist/scripts/regenerate-fixtures.js`, which re-generates all `.mjs` and preprocessor `.json` fixtures from their `.agency` sources.

---

## 3. Preprocessor Fixtures

Integration tests that verify the TypeScript preprocessor produces the expected AST from Agency source code.

**Location:** `tests/typescriptPreprocessor/`

Each test is a pair of files:
- `example.agency` — Agency source code
- `example.json` — expected preprocessed AST as JSON

**Test runner:** `lib/preprocessors/typescriptPreprocessor.integration.test.ts`

Works the same way as generator fixtures. Add an `.agency` file and run `make fixtures` to generate the `.json` fixture.

---

## 4. Agency Execution Tests (.test.json)

These tests compile and execute Agency code against an LLM, then compare the output to expected values. They use a declarative `.test.json` format where each test case makes a single call to a node.

**Location:** `tests/agency/`

Each test is a pair:
- `example.agency` — Agency source code
- `example.test.json` — test cases with inputs and expected outputs

### Test file format

```json
{
  "sourceFile": "example.agency",
  "tests": [
    {
      "nodeName": "categorize",
      "input": "\"Remind me to buy milk\"",
      "expectedOutput": "\"reminder\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "Should categorize reminder messages"
    }
  ]
}
```

**Fields:**

Per test case (entries inside `tests`):

- `nodeName` — the node to call
- `input` — arguments as a string (empty string `""` for no args)
- `expectedOutput` — expected result as a JSON string
- `evaluationCriteria` — how to compare results (see below)
- `description` (optional) — displayed when the test runs
- `interruptHandlers` (optional) — see [Interrupt Testing](./INTERRUPT_TESTING.md)
- `retry` (optional) — how many times to retry a failing test before declaring failure
- `timeoutMs` (optional) — per-test timeout in milliseconds; clamped to a hard ceiling
- `skip` (optional) — `true` to unconditionally skip this test
- `skipOnCI` (optional) — `true` to skip when running in CI (`process.env.CI` is set)
- `llmMocks` (optional) — see [Deterministic LLM mode](#deterministic-llm-mode-no-api-key) below

File-level fields (siblings of `tests`):

- `sourceFile` (optional) — the `.agency` file (relative to the `.test.json` file)
- `skip` (optional) — `true` to skip every test in the file
- `skipOnCI` (optional) — `true` to skip every test in the file when running in CI
- `skipReason` (optional) — human-readable reason printed when a file is skipped
- `defaultTimeoutMs` (optional) — file-level default timeout, overridden by per-test `timeoutMs`

### Evaluation criteria

**Exact match** — output must match `expectedOutput` exactly:

```json
{ "type": "exact" }
```

**LLM Judge** — an LLM evaluates whether the output is acceptable:

```json
{
  "type": "llmJudge",
  "judgePrompt": "Does the output correctly categorize the message?",
  "desiredAccuracy": 80
}
```

The judge returns a score from 0-100. The test passes if the score meets or exceeds `desiredAccuracy`.

### Running tests

```bash
# Run all tests in a directory (uses real OpenAI client by default)
agency test tests/agency

# Run a single test file
agency test tests/agency/categorize.test.json
```

### Deterministic LLM mode (no API key)

Set `AGENCY_USE_TEST_LLM_PROVIDER=1` to swap the real OpenAI client for a `DeterministicClient` that returns canned responses from each test case's `llmMocks` array. This is what CI uses on every PR — no `OPENAI_API_KEY` required.

```bash
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run test:agency
```

Each `llm()` call in the agency code consumes one entry from `llmMocks`, in order:

```json
{
  "nodeName": "categorize",
  "input": "\"Remind me to buy milk\"",
  "expectedOutput": "\"reminder\"",
  "evaluationCriteria": [{ "type": "exact" }],
  "llmMocks": [
    { "return": "reminder" }
  ]
}
```

**Mock entry types:**

- `{ "return": <value> }` — the LLM returns `<value>`. Strings are returned as-is; non-strings are JSON-stringified (the agency runtime parses them back per the response type annotation).
- `{ "toolCall": { "name": "...", "args": { ... } } }` — the LLM emits a tool call. Use this when an `llm(..., { tools: [...] })` call should invoke a function. Tool-using flows usually need a sequence like `[toolCall, toolCall, ..., return]` — one mock per LLM round-trip.

**Behavior under deterministic mode:**

- Tests with `evaluationCriteria.type === "llmJudge"` are auto-skipped (the judge itself is an LLM call without a mock).
- A test that calls `llm()` more times than there are mocks fails with `DeterministicClient: no mock provided for llm() call #N`.
- The deterministic client returns synthetic non-zero `usage` and `cost` so tests that only assert "value is non-zero" pass.
- `textStream` collapses to a single `done` chunk; tests that assert on intermediate streaming events won't see them.

The post-merge workflow ([`.github/workflows/test-with-llm.yml`](../../.github/workflows/test-with-llm.yml)) re-runs the same suites against the real OpenAI provider after a PR lands on `main`.

### Creating test cases interactively

The `fixtures` command walks you through creating test cases:

```bash
# Interactive — prompts for file and node
agency test fixtures

# Specify file
agency test fixtures tests/agency/example.agency

# Specify file and node
agency test fixtures tests/agency/example.agency:categorize
```

The command will:

1. Prompt you to select a node and provide arguments
2. Execute the node and show the output
3. Ask if the output is correct (or let you type the expected output)
4. Ask for evaluation criteria (exact match or LLM judge)
5. Append the test case to the corresponding `.test.json` file

If the node triggers interrupts, you'll be prompted to approve, reject, or modify each one. See [Interrupt Testing](./INTERRUPT_TESTING.md) for details.

---

## 5. Multi-Step JavaScript Tests (agency-js)

For tests that need to call a compiled Agency agent multiple times, pass results between calls, or run arbitrary imperative logic, use JavaScript integration tests.

**Location:** `tests/agency-js/`

Each test is a directory containing:

```
tests/agency-js/my-test/
├── agent.agency       # Agency source code
├── test.js            # Test script that imports the compiled agent
├── fixture.json       # Expected result
└── llmMocks.json      # (optional) Deterministic LLM mocks (see below)
```

### Writing a test script

The `test.js` file imports the compiled `.js` file (which is generated from the `.agency` file), calls it however you want, and writes the final result to `__result.json`:

```javascript
import { categorize } from "./agent.js";
import { writeFileSync } from "fs";

const result1 = await categorize("Remind me to buy milk");
const result2 = await categorize("Add eggs to my shopping list");

writeFileSync(
  "__result.json",
  JSON.stringify({ first: result1.data, second: result2.data }, null, 2),
);
```

You control everything: what arguments to pass, whether to pass `messages` between calls, how many calls to make, and what shape the final result takes.

### Running tests

```bash
# Run all tests in the directory
agency test js tests/agency-js

# Run a specific test directory
agency test js tests/agency-js/my-test
```

The runner will:

1. Find all subdirectories containing a `test.js` file
2. Compile the `.agency` file in each directory to `.js`
3. Run `test.js` with Node
4. Compare `__result.json` against `fixture.json`
5. Clean up generated files (`__result.json`, compiled `.js`)

If `fixture.json` doesn't exist yet, you'll be prompted to save the result as the new fixture.

### Deterministic LLM mode (no API key)

Agency-js tests pick up the same `AGENCY_USE_TEST_LLM_PROVIDER=1` flag as agency tests. Mocks live in a separate `llmMocks.json` file in the test directory (because `fixture.json` is the diff target). The file is a JSON array of mock entries — same format as `llmMocks` in agency `.test.json`:

```json
[
  { "return": "reminder" },
  { "return": "todo" }
]
```

```bash
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run test:agency-js
```

When `llmMocks.json` is missing under deterministic mode, an empty mock list is used and any `llm()` call throws `no mock provided` rather than falling through to the real OpenAI client.

### Generating fixtures

To auto-generate fixtures, use the `fixtures` subcommand:

```bash
agency test fixtures tests/agency-js
```

---

## Summary of Commands

```bash
# Unit tests
pnpm test                    # Vitest watch mode
pnpm test:run                # Vitest run once

# Regenerate generator/preprocessor fixtures
make fixtures

# Agency execution tests (real OpenAI client)
agency test tests/agency
agency test tests/agency/example.test.json

# Agency execution tests (deterministic — no API key required)
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run test:agency

# Create test cases interactively
agency test fixtures tests/agency/example.agency
agency test fixtures tests/agency/example.agency:nodeName

# Multi-step JavaScript tests
agency test js tests/agency-js
agency test js tests/agency-js/my-test

# Multi-step JS tests (deterministic — reads tests/agency-js/<dir>/llmMocks.json)
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run test:agency-js
```

---

## What Runs Where

### On every push and PR

**Unit tests** (`pnpm test:run`) — vitest tests for parsers, generators, runtime, and other TypeScript internals. Run on both Node 22 and Node 23.

**Structural lint** (`pnpm run lint:structure`) — eslint with Agency-specific rules (max function length, no dynamic imports, no Map/Set, etc.). Run on PRs only.

**Docs build** (`pnpm run docs`) — builds the vitepress documentation site to catch broken links or markup. Node 22 only.

**Integration tests** — run in a fresh temp directory outside the monorepo, installed from an `npm pack` tarball. Node 22 only.

- **Smoke test** (`tests/integration/smoke/test.mjs`) — installs Agency from tarball, compiles an `.agency` file, imports and runs it from TypeScript.
- **esbuild test** (`tests/integration/bundlers/test-esbuild.mjs`) — bundles a compiled Agency project with esbuild.
- **Vite test** (`tests/integration/bundlers/test-vite.mjs`) — builds a compiled Agency project with Vite (SSR mode).
- **CLI tests** (`tests/integration/cli/test.mjs`) — tests `agency run`, stdlib imports, interrupts/handlers, and the `agency test` runner.

**Stdlib sandbox tests** (`tests/integration/stdlib-sandbox/run.mjs`) — exercise real side effects (filesystem, shell, network) in controlled environments. Guarded by `CI=true` so they don't run locally. Node 22 only. Includes:

- `fs.agency` — mkdir, edit, copy, move, remove in a `/tmp` sandbox
- `shell.agency` — exec, bash, ls, stat, exists, which
- `pure.agency` — math, array, path, system, agent
- `date.agency` — now, today, tomorrow, addDays, addHours, startOfDay, endOfDay
- `policy.agency` — validatePolicy
- `ui.agency` — log, status, separator, emptyLine
- `strategy.agency` — retry, firstValid
- `wikipedia.agency` — search, summary (live API, allowed to fail)
- `weather.agency` — weather lookup, unit conversion (live API, allowed to fail)
- `http` (agency-js format) — webfetch against a local mock server

**Agency execution tests** (`pnpm run test:agency`) — compile and run `.agency` files, compare output to `.test.json` fixtures. Use the deterministic LLM client in CI (`AGENCY_USE_TEST_LLM_PROVIDER=1`). Run on both Node 22 and 23.

**Agency-JS tests** (`pnpm run test:agency-js`) — multi-step JavaScript tests that import compiled agents. Same deterministic LLM mode in CI. Run on both Node 22 and 23.

**Coverage report** — on Node 22, the agency and agency-js test runs collect step coverage data. A report is generated and posted as a PR comment showing stdlib coverage percentages.

### On push to main only

**Credential-based stdlib tests** (`tests/integration/stdlib-sandbox/credential/run.mjs`) — tests that require API keys, gated by the `ci-credentials` GitHub Environment. Never run on PRs (secrets not available to forks).

- `email.agency` — sends via Resend sandbox (no real email delivered)
- `sms.agency` — sends via Twilio test credentials (no real SMS sent)
- `browser.agency` — visits example.com via Browser Use API

**GitHub stdlib smoke test** — runs the `@agency-lang/github` package's agency tests with a real GitHub token.

**Agency and agency-js tests** - makes real llm calls

### Local only (not in CI)

**Agency tests with real LLM** — run `pnpm run test:agency` without `AGENCY_USE_TEST_LLM_PROVIDER` to use the real OpenAI client. Requires `OPENAI_API_KEY`.

**Stdlib sandbox tests** — can be run locally by setting `AGENCY_SANDBOX_TESTS=1`, but this is discouraged since they touch the real filesystem and network.
