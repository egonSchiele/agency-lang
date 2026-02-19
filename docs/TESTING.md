# Testing Guide

This document covers all the ways to write and run tests in the Agency language repo.

## Quick Reference

| Test Type | Location | Run Command |
|-----------|----------|-------------|
| Unit tests | `lib/**/*.test.ts` | `pnpm test` or `pnpm test:run` |
| Generator fixtures | `tests/typescriptGenerator/` | `pnpm test:run` |
| Preprocessor fixtures | `tests/typescriptPreprocessor/` | `pnpm test:run` |
| Agency execution tests | `tests/agency/` | `agency test tests/agency` |
| Multi-step TS tests | `tests/agency-ts/` | `agency test --ts tests/agency-ts` |

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

- `sourceFile` — the `.agency` file (relative to the `.test.json` file)
- `nodeName` — the node to call
- `input` — arguments as a string (empty string `""` for no args)
- `expectedOutput` — expected result as a JSON string
- `evaluationCriteria` — how to compare results (see below)
- `description` (optional) — displayed when the test runs
- `interruptHandlers` (optional) — see [Interrupt Testing](./INTERRUPT_TESTING.md)

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
# Run all tests in a directory
agency test tests/agency

# Run a single test file
agency test tests/agency/categorize.test.json
```

### Creating test cases interactively

The `fixtures` command walks you through creating test cases:

```bash
# Interactive — prompts for file and node
agency fixtures

# Specify file
agency fixtures tests/agency/example.agency

# Specify file and node
agency fixtures tests/agency/example.agency:categorize
```

The command will:

1. Prompt you to select a node and provide arguments
2. Execute the node and show the output
3. Ask if the output is correct (or let you type the expected output)
4. Ask for evaluation criteria (exact match or LLM judge)
5. Append the test case to the corresponding `.test.json` file

If the node triggers interrupts, you'll be prompted to approve, reject, or modify each one. See [Interrupt Testing](./INTERRUPT_TESTING.md) for details.

---

## 5. Multi-Step TypeScript Tests (agency-ts)

For tests that need to call a compiled Agency agent multiple times, pass results between calls, or run arbitrary imperative logic, use TypeScript integration tests.

**Location:** `tests/agency-ts/`

Each test is a directory containing:

```
tests/agency-ts/my-test/
├── agent.agency       # Agency source code
├── test.js            # Test script that imports the compiled agent
└── fixture.json       # Expected result
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
agency test --ts tests/agency-ts

# Run a specific test directory
agency test --ts tests/agency-ts/my-test
```

The runner will:

1. Find all subdirectories containing a `test.js` file
2. Compile the `.agency` file in each directory to `.js`
3. Run `test.js` with Node
4. Compare `__result.json` against `fixture.json`
5. Clean up generated files (`__result.json`, compiled `.js`)

If `fixture.json` doesn't exist yet, you'll be prompted to save the result as the new fixture.

### Generating fixtures

To auto-generate (or regenerate) fixtures without being prompted:

```bash
agency test --gen-fixtures tests/agency-ts
```

This compiles and runs each test, then saves the result directly as `fixture.json`.

---

## Summary of Commands

```bash
# Unit tests
pnpm test                    # Vitest watch mode
pnpm test:run                # Vitest run once

# Regenerate generator/preprocessor fixtures
make fixtures

# Agency execution tests
agency test tests/agency
agency test tests/agency/example.test.json

# Create test cases interactively
agency fixtures tests/agency/example.agency
agency fixtures tests/agency/example.agency:nodeName

# Multi-step TypeScript tests
agency test --ts tests/agency-ts
agency test --ts tests/agency-ts/my-test

# Generate TypeScript test fixtures
agency test --gen-fixtures tests/agency-ts
```
