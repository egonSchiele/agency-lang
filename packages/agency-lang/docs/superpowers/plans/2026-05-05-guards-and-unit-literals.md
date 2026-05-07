# Guards and Unit Literals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resource guards (cost, timeout, depth) as a block construct, and unit literals (time/cost) as compile-time syntactic sugar.

**Architecture:** Unit literals are parsed as a new numeric token variant and normalized to plain numbers at compile time. Guards are a new block construct (similar to `handle`) that wraps execution with resource tracking and triggers interrupts (cost) or failures (timeout/depth) when limits are exceeded. The failure type is also updated to standardize `error` as string and add a `data` field.

**Tech Stack:** Tarsec (parser), TypeScript IR, existing runtime infrastructure (token tracking, AbortSignal, handlers)

---

## File Structure

### New files:
- `lib/parsers/unitLiteral.ts` — parser for unit suffix literals
- `lib/parsers/unitLiteral.test.ts` — unit tests for unit literal parser
- `lib/parsers/guardBlock.ts` — parser for guard block
- `lib/parsers/guardBlock.test.ts` — unit tests for guard block parser
- `lib/types/guardBlock.ts` — AST type definition
- `lib/runtime/guard.ts` — runtime guard execution (runGuard)
- `lib/runtime/guard.test.ts` — unit tests for guard runtime
- `lib/templates/backends/typescriptGenerator/guardBlock.mustache` — template (if needed)
- `tests/agency/guards/` — integration tests
- `tests/typescriptGenerator/guard*.agency` + `.mts` — fixture tests

### Modified files:
- `lib/parsers/parsers.ts` — wire in unit literal + guard block parsers
- `lib/types.ts` — export new AST type, add to AgencyNode union
- `lib/types/numberLiteral.ts` or equivalent — extend number type with optional unit info
- `lib/backends/typescriptBuilder.ts` — code gen for guard blocks and unit literals
- `lib/runtime/result.ts` — standardize failure type (error: string, add data field)
- `lib/config.ts` — add global `guards` config option
- `lib/preprocessors/typescriptPreprocessor.ts` — handle guard block traversal if needed
- `lib/typeChecker.ts` — dimension mismatch check for unit expressions

---

### Task 1: Standardize the failure type

This is a prerequisite change that can land independently.

**Files:**
- Modify: `lib/runtime/result.ts`
- Modify: any callers that pass non-string `error` values
- Test: `lib/runtime/result.test.ts` (if it exists, otherwise add assertions to existing tests)

- [ ] **Step 1: Read the existing result.ts to understand all usages**

Search for all callers of `failure()` across the codebase to understand what's currently passed as `error`.

- [ ] **Step 2: Write a failing test for the new failure signature**

```ts
// In a test file
import { failure } from "../lib/runtime/result.js";

test("failure accepts string error and optional data", () => {
  const f = failure("something went wrong", { code: 42 });
  expect(f.error).toBe("something went wrong");
  expect(f.data).toEqual({ code: 42 });
});

test("failure without data has null data field", () => {
  const f = failure("oops");
  expect(f.data).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:run -- --testPathPattern result` (or relevant pattern)
Expected: FAIL — `data` property doesn't exist on ResultFailure

- [ ] **Step 4: Update ResultFailure type and failure() function**

In `lib/runtime/result.ts`:

```ts
export type ResultFailure = {
  __type: "resultType";
  success: false;
  error: string;
  data: Record<string, any> | null;
  checkpoint: any;
  retryable: boolean;
  functionName: string | null;
  args: Record<string, any> | null;
};

export function failure(error: string, data?: Record<string, any>, opts?: FailureOpts): ResultFailure {
  return {
    __type: "resultType",
    success: false,
    error,
    data: data ?? null,
    checkpoint: opts?.checkpoint ?? null,
    retryable: opts?.retryable ?? false,
    functionName: opts?.functionName ?? null,
    args: opts?.args ?? null,
  };
}
```

- [ ] **Step 5: Fix all existing callers**

Update any callers that pass non-string values as the first argument to `failure()`. The internal `opts` (checkpoint, retryable, etc.) need to move to the third argument.

- [ ] **Step 6: Run full test suite to verify nothing is broken**

Run: `pnpm test:run 2>&1 | tee /tmp/claude/task1-tests.log`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: standardize failure type — error is always string, add data field"
```

---

### Task 2: Parse unit literals

**Files:**
- Create: `lib/parsers/unitLiteral.ts`
- Create: `lib/parsers/unitLiteral.test.ts`
- Modify: `lib/parsers/parsers.ts` — integrate into expression parsing
- Modify: `lib/types.ts` or relevant type file

- [ ] **Step 1: Define the AST node type**

Either extend the existing `NumberLiteral` type or create a new `UnitLiteral` type:

```ts
export type UnitLiteral = BaseNode & {
  type: "unitLiteral";
  value: string;          // the raw numeric part, e.g. "30"
  unit: string;           // "ms" | "s" | "m" | "h" | "d" | "w" | "$"
  canonicalValue: number; // the normalized value, e.g. 30000 for 30s
};
```

Add to the `AgencyNode` union in `lib/types.ts`.

- [ ] **Step 2: Write failing parser tests**

In `lib/parsers/unitLiteral.test.ts`:

```ts
import { unitLiteralParser } from "./unitLiteral.js";

describe("unitLiteralParser", () => {
  test("parses seconds", () => {
    const result = unitLiteralParser("30s");
    expect(result.success).toBe(true);
    expect(result.value.unit).toBe("s");
    expect(result.value.canonicalValue).toBe(30000);
  });

  test("parses milliseconds", () => {
    const result = unitLiteralParser("500ms");
    expect(result.success).toBe(true);
    expect(result.value.unit).toBe("ms");
    expect(result.value.canonicalValue).toBe(500);
  });

  test("parses minutes", () => {
    const result = unitLiteralParser("5m");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(300000);
  });

  test("parses hours", () => {
    const result = unitLiteralParser("2h");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(7200000);
  });

  test("parses days", () => {
    const result = unitLiteralParser("7d");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(604800000);
  });

  test("parses weeks", () => {
    const result = unitLiteralParser("1w");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(604800000);
  });

  test("parses dollar cost", () => {
    const result = unitLiteralParser("$5.00");
    expect(result.success).toBe(true);
    expect(result.value.unit).toBe("$");
    expect(result.value.canonicalValue).toBe(5.00);
  });

  test("parses decimal seconds", () => {
    const result = unitLiteralParser("0.5s");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(500);
  });

  test("does not parse plain numbers", () => {
    const result = unitLiteralParser("42");
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run -- --testPathPattern unitLiteral 2>&1 | tee /tmp/claude/task2-tests.log`
Expected: FAIL — module doesn't exist

- [ ] **Step 4: Implement the unit literal parser**

In `lib/parsers/unitLiteral.ts`:

```ts
import { Parser, seq, or, map, regex, label } from "tarsec";

const MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  w: 604800000,
};

// Time unit: number followed by unit suffix
const timeUnitParser: Parser<UnitLiteral> = label("a time unit literal",
  map(
    seq(regex(/[0-9]+(\.[0-9]+)?/), regex(/(ms|s|m|h|d|w)\b/)),
    ([numStr, unit]) => ({
      type: "unitLiteral" as const,
      value: numStr,
      unit,
      canonicalValue: parseFloat(numStr) * MULTIPLIERS[unit],
    })
  )
);

// Cost unit: $ followed by number
const costUnitParser: Parser<UnitLiteral> = label("a cost unit literal",
  map(
    seq(regex(/\$/), regex(/[0-9]+(\.[0-9]+)?/)),
    ([_, numStr]) => ({
      type: "unitLiteral" as const,
      value: numStr,
      unit: "$",
      canonicalValue: parseFloat(numStr),
    })
  )
);

export const unitLiteralParser: Parser<UnitLiteral> = or(costUnitParser, timeUnitParser);
```

Note: The exact Tarsec combinators used will need to match the library's API. Check existing parsers for patterns.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run -- --testPathPattern unitLiteral 2>&1 | tee /tmp/claude/task2-tests2.log`
Expected: PASS

- [ ] **Step 6: Wire into main expression parser**

In `lib/parsers/parsers.ts`, add `unitLiteralParser` as an alternative in the primary expression parser. It should be tried **before** the plain `numberParser` since `30s` would otherwise be parsed as `30` followed by an identifier `s`.

- [ ] **Step 7: Verify existing parser tests still pass**

Run: `pnpm test:run -- --testPathPattern parser 2>&1 | tee /tmp/claude/task2-parser-tests.log`
Expected: All existing parser tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add unit literal parser (ms, s, m, h, d, w, $)"
```

---

### Task 3: Code generation for unit literals

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` — emit canonical number for unit literals
- Create: `tests/typescriptGenerator/unitLiterals.agency` + `.mts` — fixture test

- [ ] **Step 1: Write a fixture test**

Create `tests/typescriptGenerator/unitLiterals.agency`:

```ts
node main() {
  const timeout = 30s
  const cost = $5.00
  const halfSec = 500ms
  const twoHours = 2h
  return timeout
}
```

Create the corresponding `.mts` expected output file showing that `30s` compiles to `30000`, `$5.00` to `5.00`, etc.

- [ ] **Step 2: Add case in typescriptBuilder.ts**

In `processNode`, add a case for `"unitLiteral"`:

```ts
case "unitLiteral":
  return ts.num(node.canonicalValue);
```

This simply emits the pre-computed canonical value as a numeric literal.

- [ ] **Step 3: Run fixture tests**

Run: `pnpm test:run -- --testPathPattern typescriptGenerator 2>&1 | tee /tmp/claude/task3-tests.log`
Expected: New fixture passes, existing fixtures unaffected.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: code generation for unit literals — emit canonical numbers"
```

---

### Task 4: Typechecker — dimension mismatch detection

**Files:**
- Modify: `lib/typeChecker.ts` — track dimensions through expressions, error on mismatch
- Test: add test cases in typeChecker tests

- [ ] **Step 1: Write failing typechecker tests**

Test that `1s + $5.00` produces a type error, and that `1s + 500ms` does not.

- [ ] **Step 2: Implement dimension tracking**

In the typechecker, when a `unitLiteral` node is encountered, tag the inferred type with a dimension (`"time"` or `"cost"`). When a binary operation combines two dimensioned values, check that dimensions match. A dimensioned value combined with a plain number is allowed (e.g. `30s * 2`).

- [ ] **Step 3: Run typechecker tests**

Run: `pnpm test:run -- --testPathPattern typeCheck 2>&1 | tee /tmp/claude/task4-tests.log`
Expected: New tests pass, existing tests unaffected.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: typechecker dimension mismatch detection for unit literals"
```

---

### Task 5: Parse guard blocks

**Files:**
- Create: `lib/types/guardBlock.ts` — AST type
- Create: `lib/parsers/guardBlock.ts` — parser
- Create: `lib/parsers/guardBlock.test.ts` — tests
- Modify: `lib/types.ts` — export and add to union
- Modify: `lib/parsers/parsers.ts` — wire in

- [ ] **Step 1: Define the AST node type**

In `lib/types/guardBlock.ts`:

```ts
import { BaseNode, AgencyNode } from "../types.js";

export type GuardBlock = BaseNode & {
  type: "guardBlock";
  limits: GuardLimit[];
  body: AgencyNode[];
};

export type GuardLimit = {
  name: string;   // "cost" | "timeout" | "depth"
  value: AgencyNode;  // expression (usually a unit literal or number)
};
```

- [ ] **Step 2: Write failing parser tests**

In `lib/parsers/guardBlock.test.ts`:

```ts
describe("guardBlockParser", () => {
  test("parses guard with single limit", () => {
    const result = parse("guard (timeout: 30s) { print(1) }");
    expect(result.type).toBe("guardBlock");
    expect(result.limits).toHaveLength(1);
    expect(result.limits[0].name).toBe("timeout");
  });

  test("parses guard with multiple limits", () => {
    const result = parse("guard (cost: $5.00, timeout: 30s, depth: 10) { print(1) }");
    expect(result.type).toBe("guardBlock");
    expect(result.limits).toHaveLength(3);
  });

  test("parses guard with body containing multiple statements", () => {
    const input = `guard (timeout: 10s) {
      const x = llm("hello")
      print(x)
    }`;
    const result = parse(input);
    expect(result.body).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run -- --testPathPattern guardBlock 2>&1 | tee /tmp/claude/task5-tests.log`

- [ ] **Step 4: Implement the guard block parser**

In `lib/parsers/guardBlock.ts`:

The parser structure is:
1. Parse `guard` keyword
2. Parse `(`
3. Parse comma-separated list of `name: expression` pairs
4. Parse `)`
5. Parse `{` body statements `}`

Pattern it after `handleBlockParser` in parsers.ts for the body parsing.

- [ ] **Step 5: Wire into statement parser in parsers.ts**

Add `guardBlockParser` as an alternative in the statement-level parser list.

- [ ] **Step 6: Run all parser tests**

Run: `pnpm test:run -- --testPathPattern parser 2>&1 | tee /tmp/claude/task5-tests2.log`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: parse guard blocks"
```

---

### Task 6: Guard runtime implementation

**Files:**
- Create: `lib/runtime/guard.ts`
- Create: `lib/runtime/guard.test.ts`

- [ ] **Step 1: Write failing runtime tests**

```ts
describe("runGuard", () => {
  test("returns block result on success (no limit hit)", async () => {
    const result = await runGuard({ timeout: 5000 }, async (ctx) => {
      return "hello";
    });
    expect(result).toBe("hello");
  });

  test("returns failure on timeout", async () => {
    const result = await runGuard({ timeout: 50 }, async () => {
      await new Promise(r => setTimeout(r, 200));
      return "too late";
    });
    expect(isFailure(result)).toBe(true);
    expect(result.error).toContain("Timeout");
    expect(result.data.guard).toBe("timeout");
  });

  test("returns failure on depth exceeded", async () => {
    // test depth tracking
  });

  test("throws interrupt on cost exceeded", async () => {
    // test cost interrupt
  });
});
```

- [ ] **Step 2: Implement runGuard**

In `lib/runtime/guard.ts`:

```ts
export type GuardLimits = {
  cost?: number;      // in dollars
  timeout?: number;   // in milliseconds
  depth?: number;     // max LLM call rounds
};

export async function runGuard(
  limits: GuardLimits,
  body: () => Promise<any>,
  ctx: RuntimeContext,
): Promise<any> {
  const startTime = Date.now();
  const checkpoint = ctx.checkpoints.create(/* ... */);

  // Timeout: use AbortSignal.timeout or setTimeout
  if (limits.timeout !== undefined) {
    const timeoutId = setTimeout(() => {
      // cancel via ctx.abort()
    }, limits.timeout);
    // ... wrap body execution, clear timeout on completion
  }

  // Cost: hook into token stats tracking, check after each LLM call
  // If exceeded, throw interrupt with guard data

  // Depth: increment counter on each LLM call, check against limit
  // If exceeded, return failure

  // On success, return the block's return value
}
```

The exact integration points:
- **Timeout**: Use the existing `AbortController` on `ctx`. Set a timeout that calls `ctx.cancel()`. Catch `AgencyCancelledError` and convert to a failure with guard metadata.
- **Cost**: Register a post-LLM-call hook (or check after `updateTokenStats`) that compares cumulative cost against the limit. If exceeded, throw an interrupt.
- **Depth**: Wrap the `maxToolCallRounds` mechanism or add a counter that increments on each `runPrompt` call within the guard scope.

- [ ] **Step 3: Run tests**

Run: `pnpm test:run -- --testPathPattern guard 2>&1 | tee /tmp/claude/task6-tests.log`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: guard runtime — timeout, cost, and depth enforcement"
```

---

### Task 7: Code generation for guard blocks

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` — add `processGuardBlock` method
- Modify: `lib/preprocessors/typescriptPreprocessor.ts` — traverse guard block body
- Create: `tests/typescriptGenerator/guardBlock.agency` + `.mts`

- [ ] **Step 1: Write fixture test**

Create `tests/typescriptGenerator/guardBlock.agency`:

```ts
node main() {
  const result = guard (cost: $5.00, timeout: 30s) {
    const x = llm("hello")
    return x
  }
  print(result)
}
```

- [ ] **Step 2: Add processGuardBlock in typescriptBuilder.ts**

Pattern after `processHandleBlockWithSteps`. The generated code should look something like:

```ts
const result = await __runGuard(
  { cost: 5.00, timeout: 30000 },
  async (runner) => {
    // body statements with substep tracking
  },
  __ctx
);
```

- [ ] **Step 3: Handle guard blocks in preprocessor**

Ensure the preprocessor traverses into guard block bodies for variable scoping, async marking, etc.

- [ ] **Step 4: Run fixture tests**

Run: `pnpm test:run -- --testPathPattern typescriptGenerator 2>&1 | tee /tmp/claude/task7-tests.log`
Expected: New fixture passes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: code generation for guard blocks"
```

---

### Task 8: Guard + catch integration

**Files:**
- Create: `tests/agency/guards/guardCatch.agency` — integration test
- Possibly modify: `lib/backends/typescriptBuilder.ts` if catch needs special handling with guards

- [ ] **Step 1: Write integration test**

Create `tests/agency/guards/guardCatch.agency`:

```ts
node main() {
  const result = guard (timeout: 50ms) {
    sleep(1)
    return "done"
  } catch "timed out"
  return result
}
```

Expected result: `"timed out"`

- [ ] **Step 2: Run integration test**

Run: `pnpm run agency test tests/agency/guards/guardCatch.agency 2>&1 | tee /tmp/claude/task8-tests.log`
Expected: Test passes — guard times out, catch provides fallback.

- [ ] **Step 3: Write test for cost guard with handler**

Create `tests/agency/guards/guardCostHandler.agency`:

```ts
def expensiveWork(): string {
  return llm("Write something")
}

node main() {
  handle {
    guard (cost: $0.001) {
      return expensiveWork()
    }
  } with (data) {
    return reject()
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: guard integration tests — catch and handler composition"
```

---

### Task 9: Global guards config

**Files:**
- Modify: `lib/config.ts` — add `guards` option
- Modify: `lib/runtime/guard.ts` or `lib/runtime/node.ts` — apply global guards as defaults

- [ ] **Step 1: Add config option**

In `lib/config.ts`, add to `AgencyConfig`:

```ts
/** Global guard limits applied to all execution. Block-level guards use the stricter value. */
guards?: {
  cost?: number;
  timeout?: number;
  depth?: number;
};
```

- [ ] **Step 2: Apply global guards at node entry**

When a node starts executing, if global guards are configured, wrap the execution in a guard with those limits. Block-level guards within should use `Math.min(blockLimit, globalLimit)` for each dimension.

- [ ] **Step 3: Write integration test with agency.json config**

Create a test directory with an `agency.json`:

```json
{
  "guards": {
    "timeout": 60000,
    "depth": 20
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run 2>&1 | tee /tmp/claude/task9-tests.log`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: global guards config in agency.json"
```

---

### Task 10: Guard nesting semantics

**Files:**
- Create: `tests/agency/guards/guardNesting.agency` — nested guard tests
- Modify: `lib/runtime/guard.ts` — cost accumulation across nested guards

- [ ] **Step 1: Write nesting integration test**

```ts
node main() {
  const result = guard (timeout: 5s) {
    const inner = guard (timeout: 50ms) {
      sleep(1)
      return "inner done"
    } catch "inner timed out"
    return inner
  }
  return result
}
```

Expected: `"inner timed out"` — inner guard fires, outer guard is fine.

- [ ] **Step 2: Write cost accumulation test**

Test that cost spent in an inner guard block counts toward the outer guard's budget.

- [ ] **Step 3: Run tests**

Run: `pnpm run agency test tests/agency/guards/guardNesting.agency 2>&1 | tee /tmp/claude/task10-tests.log`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: nested guard semantics — cost accumulation and independent timeouts"
```

---

### Task 11: Update date stdlib with unified `add` function

**Files:**
- Modify: `stdlib/date.agency`
- Modify: `stdlib/lib/date.js` (or `.ts`) — add `_add` implementation
- Test: add test for the new function

- [ ] **Step 1: Implement `_add` in the JS backing file**

The function takes a datetime string and a duration in milliseconds, adds it, and returns a new ISO 8601 string.

- [ ] **Step 2: Export `add` from date.agency**

```ts
/** Add a duration to a datetime string. Use with unit literals: add(now(), 2h), add(start, 30m) */
export safe def add(datetime: string, duration: number): string {
  """
  Add a duration (in milliseconds) to a datetime string. Returns a new ISO 8601 datetime string. Use with unit literals for clarity: add(now(), 2h), add(start, 7d). Negative values subtract.
  """
  return _add(datetime, duration)
}
```

- [ ] **Step 3: Write integration test**

```ts
import { now, add } from "std::date"

node main() {
  const future = add(now(), 2h)
  print(future)
  return future
}
```

- [ ] **Step 4: Run `make` to rebuild stdlib**

Run: `make`

- [ ] **Step 5: Run tests**

Run: `pnpm test:run 2>&1 | tee /tmp/claude/task11-tests.log`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add unified add() function to date stdlib for use with unit literals"
```

---

### Task 12: Documentation

**Files:**
- Modify: `docs-new/guide/` — add guards section or new page
- Modify: date stdlib docstring

- [ ] **Step 1: Write guards documentation page**

Add `docs-new/guide/guards.md` covering syntax, behavior, nesting, and examples.

- [ ] **Step 2: Update types documentation**

Add unit literals to the types page or create a dedicated section.

- [ ] **Step 3: Update date stdlib examples**

Update the module docstring in `stdlib/date.agency` to show the `add()` function with unit literals.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add guards and unit literals documentation"
```
