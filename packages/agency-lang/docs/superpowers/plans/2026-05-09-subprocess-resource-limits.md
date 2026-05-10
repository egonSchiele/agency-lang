# Subprocess Resource Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-call resource limits (wall-clock, memory, IPC payload, stdout) to `std::agency`'s `run()` function, so a parent agent can constrain runaway subprocess behavior. Refactor `run()` to flat parameters so individual limits can be partially applied.

**Architecture:** Limits are enforced entirely from the parent side via standard Node primitives — `setTimeout`, `--max-old-space-size`, byte-counting Transform streams, and JSON.stringify length checks. No new IPC protocols, no native modules. Bytes get a new unit literal class (`b`, `kb`, `mb`, `gb`) parallel to existing time literals. Limit violations turn into structured `Result.failure` values with consistent shape.

**Tech Stack:** TypeScript runtime (`lib/runtime/ipc.ts`, `lib/runtime/subprocess-bootstrap.ts`); Agency stdlib (`stdlib/agency.agency`); existing parser combinator infrastructure (`lib/parsers/parsers.ts`); existing dimension-mismatch type checker (`lib/typeChecker/dimensionMismatch.test.ts`).

**Spec:** [docs/superpowers/specs/2026-05-09-subprocess-resource-limits-design.md](../specs/2026-05-09-subprocess-resource-limits-design.md)

---

## File Structure

**Files to create:**

- `tests/agency/subprocess/limit-wall-clock.agency` + `.test.json` — exercises wall-clock kill
- `tests/agency/subprocess/limit-memory.agency` + `.test.json` — exercises OOM kill
- `tests/agency/subprocess/limit-ipc-payload.agency` + `.test.json` — exercises payload-too-big failure
- `tests/agency/subprocess/limit-stdout.agency` + `.test.json` — exercises stdout truncation + kill
- `tests/agency/subprocess/limit-cap-clamping.agency` + `.test.json` — exercises clamp-to-ceiling behavior
- `tests/agency/subprocess/limit-partial-application.agency` + `.test.json` — verifies `run.partial(wallClock: 1s)` works

**Files to modify:**

- `lib/types/literals.ts` — add `ByteUnitLiteral`, extend `UnitLiteral` union
- `lib/parsers/parsers.ts` — add `byteUnitParser`, register in `unitLiteralParser`
- `lib/parsers/unitLiteral.test.ts` — add bytes tests
- `lib/typeChecker/synthesizer.ts` — generalize the dimension-mismatch error message at line 168 (currently hardcodes "time and cost")
- `lib/typeChecker/dimensionMismatch.test.ts` — add cross-dimension tests for bytes

`lib/backends/agencyGenerator.ts` and `lib/backends/typescriptBuilder.ts` need **no** changes — `agencyGenerator` calls dimension-agnostic `formatUnitLiteral(literal)`, and `typescriptBuilder` emits `ts.num(literal.canonicalValue)`. Both flow new byte units through automatically.
- `stdlib/agency.agency` — change `run()` signature to flat params with byte/time defaults
- `lib/runtime/ipc.ts` — bulk of work: new options on `_run`, cap clamping, wall-clock timer, memory exec arg, IPC payload check, stdout pipe-and-count, failure shape constructor
- `lib/runtime/subprocess-bootstrap.ts` — IPC payload check on result message
- All seven existing `tests/agency/subprocess/*.agency` files (`run-basic`, `run-with-args`, `handler-approve`, `handler-reject`, `nested-blocked`, `run-multiple-interrupts`, `run-crash`, `run-abnormal-exit`) — update `run(compiled, { node, args })` to flat-arg form
- `docs-new/stdlib/agency.md` — regenerate via `make` after `stdlib/agency.agency` changes

**Files to verify (read but probably no changes):**

- `lib/templates/backends/typescriptGenerator/imports.mustache` — confirm the `_run` AgencyFunction wrapping doesn't need parameter changes (it forwards `compiled` and `options`; if signature changes to many params, this needs updating)
- `lib/runtime/index.ts` — `_run` export

---

## Task 1: Add byte unit literals to the language

**Files:**
- Modify: `lib/types/literals.ts` (around line 18-34)
- Modify: `lib/parsers/parsers.ts` (around line 380-425)
- Modify: `lib/parsers/unitLiteral.test.ts`
- Modify: `lib/typeChecker/synthesizer.ts` (line 168 — generalize the error message)
- Modify: `lib/typeChecker/dimensionMismatch.test.ts`

- [ ] **Step 1.1: Read existing time-literal infrastructure to understand the pattern**

Run: `grep -n "TimeUnitLiteral\|TIME_MULTIPLIERS\|timeUnitParser\|costUnitParser" lib/parsers/parsers.ts lib/types/literals.ts lib/backends/*.ts`

Expected: see exact line numbers for each piece. Read each in context.

- [ ] **Step 1.2: Write failing test for byte parser**

Add to `lib/parsers/unitLiteral.test.ts`:

```ts
describe("byte unit literals", () => {
  it("parses bytes (b)", () => {
    const result = unitLiteralParser("100b");
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      type: "unitLiteral",
      dimension: "bytes",
      value: "100",
      unit: "b",
      canonicalValue: 100,
    });
  });

  it("parses kilobytes (kb)", () => {
    const result = unitLiteralParser("1kb");
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ canonicalValue: 1024, unit: "kb" });
  });

  it("parses megabytes (mb)", () => {
    const result = unitLiteralParser("1mb");
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ canonicalValue: 1048576, unit: "mb" });
  });

  it("parses gigabytes (gb)", () => {
    const result = unitLiteralParser("4gb");
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ canonicalValue: 4 * 1024 * 1024 * 1024, unit: "gb" });
  });

  it("parses fractional bytes (e.g., 1.5mb)", () => {
    const result = unitLiteralParser("1.5mb");
    expect(result.success).toBe(true);
    expect(result.result.canonicalValue).toBe(Math.round(1.5 * 1024 * 1024));
  });
});
```

- [ ] **Step 1.3: Run tests to verify they fail**

Run: `pnpm vitest run lib/parsers/unitLiteral.test.ts`
Expected: 5 new tests failing because byte units aren't recognized.

- [ ] **Step 1.4: Implement `ByteUnitLiteral` type**

In `lib/types/literals.ts`, add alongside `TimeUnitLiteral` and `CostUnitLiteral`:

```ts
export type ByteUnitLiteral = BaseNode & {
  type: "unitLiteral";
  dimension: "bytes";
  value: string;
  unit: "b" | "kb" | "mb" | "gb";
  canonicalValue: number;
};

export type UnitLiteral = TimeUnitLiteral | CostUnitLiteral | ByteUnitLiteral;
```

Update `formatUnitLiteral` if it switches on dimension or unit.

- [ ] **Step 1.5: Implement `byteUnitParser` in `parsers.ts`**

Following the `timeUnitParser` pattern (around line 392):

```ts
const BYTE_MULTIPLIERS: Record<ByteUnitLiteral["unit"], number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

// Order matters — longest match first so "mb" matches before "b"
const byteSuffix = or(str("kb"), str("mb"), str("gb"), str("b"));

const byteUnitParser: Parser<UnitLiteral> = label("a byte unit literal", (input: string): ParserResult<UnitLiteral> => {
  const parser = seq(
    set("type", "unitLiteral"),
    set("dimension", "bytes"),
    capture(numberParser, "value"),
    capture(byteSuffix, "unit"),
  );
  const result = parser(input);
  if (!result.success) return result;
  const { value, unit } = result.result;
  return success({
    ...result.result,
    canonicalValue: Math.round(parseFloat(value) * BYTE_MULTIPLIERS[unit as ByteUnitLiteral["unit"]]),
  } as UnitLiteral, result.rest);
});
```

Add to the `unitLiteralParser` `or(...)` (line 425). **Order matters**: put `byteUnitParser` before `timeUnitParser` so `1kb` doesn't match as `1k` followed by `b`. Confirm by reading the parser combinator; `or` is short-circuit left-to-right.

```ts
export const unitLiteralParser: Parser<UnitLiteral> = label("a unit literal",
  or(costUnitParser, byteUnitParser, timeUnitParser)
)
```

- [ ] **Step 1.6: Run tests to verify they pass**

Run: `pnpm vitest run lib/parsers/unitLiteral.test.ts`
Expected: all tests pass, including pre-existing time/cost tests.

- [ ] **Step 1.7: Add dimension-mismatch tests**

In `lib/typeChecker/dimensionMismatch.test.ts`, add a `bytesLit` factory and tests:

```ts
function bytesLit(value: string, unit: ByteUnitLiteral["unit"], canonicalValue: number): ByteUnitLiteral {
  return { type: "unitLiteral", value, unit, canonicalValue, dimension: "bytes" };
}

describe("bytes dimension", () => {
  it("allows same-dimension byte operations", () => {
    const program = programWithBinOp("+", bytesLit("1", "mb", 1048576), bytesLit("100", "kb", 102400));
    const errors = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("errors on bytes + time", () => {
    const program = programWithBinOp("+", bytesLit("1", "mb", 1048576), timeLit("1", "s", 1000));
    const errors = typeCheck(program);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("dimensions");
  });

  it("errors on bytes + cost", () => {
    const program = programWithBinOp("+", bytesLit("1", "mb", 1048576), costLit("5.00", 5));
    const errors = typeCheck(program);
    expect(errors).toHaveLength(1);
  });

  it("allows bytes * plain number", () => {
    const program = programWithBinOp("*", bytesLit("1", "mb", 1048576), { type: "number", value: "2" });
    const errors = typeCheck(program);
    expect(errors).toHaveLength(0);
  });
});
```

Run: `pnpm vitest run lib/typeChecker/dimensionMismatch.test.ts`
Expected: tests pass for "allows same-dimension byte operations" and "allows bytes * plain number" (the synthesizer reads `dimension` straight from the literal — already dimension-agnostic). The two cross-dimension error tests will pass on the assertion `errors.toHaveLength(1)` but the error *message* still says "time and cost" because of the hardcoded string in `synthesizer.ts:168`.

- [ ] **Step 1.8: Generalize the dimension-mismatch error message**

In `lib/typeChecker/synthesizer.ts` around line 168, change:

```ts
message: `Cannot ${op} time and cost values: '${formatUnitLiteral(expr.left)}' and '${formatUnitLiteral(expr.right)}' have different dimensions.`,
```

to:

```ts
message: `Cannot ${op} values of different dimensions (${expr.left.dimension} and ${expr.right.dimension}): '${formatUnitLiteral(expr.left)}' and '${formatUnitLiteral(expr.right)}'.`,
```

Update any pre-existing tests in `dimensionMismatch.test.ts` that asserted on the old message (likely just `expect(errors[0].message).toContain("dimensions")` which still holds — confirm by re-running).

- [ ] **Step 1.9: Verify backend round-trip (no changes expected)**

`lib/backends/agencyGenerator.ts` calls `formatUnitLiteral(literal)` (dimension-agnostic). `lib/backends/typescriptBuilder.ts` calls `ts.num(literal.canonicalValue)` (dimension-agnostic). Bytes should round-trip without backend changes. Verify:

```bash
echo 'node main() { return 1mb }' > /tmp/test-bytes.agency
pnpm run agency /tmp/test-bytes.agency
# Expected: prints 1048576
pnpm run fmt /tmp/test-bytes.agency
# Expected: round-trips back to "1mb"
rm /tmp/test-bytes.agency
```

If either step fails (would be surprising), debug and add bytes handling in the relevant backend following the time-literal pattern.

- [ ] **Step 1.10: Run full test suite for parser and type checker**

Run: `pnpm vitest run lib/parsers lib/typeChecker`
Expected: all green.

- [ ] **Step 1.11: Commit**

```bash
git add lib/types/literals.ts lib/parsers/parsers.ts lib/parsers/unitLiteral.test.ts lib/typeChecker/synthesizer.ts lib/typeChecker/dimensionMismatch.test.ts
git commit -F- <<'MSG'
feat: add b/kb/mb/gb byte unit literals

Parallel to existing s/ms/m/h time literals. Normalize to bytes
(1mb = 1048576). Same dimension-mismatch rules apply: bytes cannot
be mixed with time or cost.

Needed for upcoming subprocess resource limits which will use
byte-typed parameters like `memory: 512mb`.
MSG
```

---

## Task 2: Refactor `run()` to flat parameters (breaking change)

**Files:**
- Modify: `stdlib/agency.agency`
- Modify: `lib/runtime/ipc.ts` — `_run` signature
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` — `_run` AgencyFunction wrapper params
- Modify: all seven existing `tests/agency/subprocess/*.agency` files
- Modify: regenerated typescriptBuilder snapshot fixtures (`tests/typescriptBuilder/*.mjs`, `tests/typescriptGenerator/*.mjs`) — same `_run` line as imports.mustache emits

- [ ] **Step 2.1: Update Agency-side `run()` signature**

In `stdlib/agency.agency`, replace the existing `run()` with:

```ts
export def run(
  compiled: CompiledProgram,
  node: string,
  args: object,
  wallClock: number = 60s,
  memory: number = 512mb,
  ipcPayload: number = 100mb,
  stdout: number = 1mb,
): Result {
  """
  Execute a compiled Agency program in a subprocess. The parent's handler chain extends to the subprocess — subprocess interrupts must be approved by both subprocess and parent handlers. Returns the subprocess node's result on success.

  Resource limits clamp the subprocess: it is killed and a limit_exceeded failure is returned if it exceeds wallClock, memory, ipcPayload, or stdout.

  @param compiled - A CompiledProgram from compile()
  @param node - Which exported node to run
  @param args - Arguments to pass to the node
  @param wallClock - Max wall-clock time before SIGKILL (default 60s, max 1h)
  @param memory - Max V8 heap size (default 512mb, max 4gb)
  @param ipcPayload - Max single IPC message size (default 100mb, max 1gb)
  @param stdout - Max combined stdout+stderr bytes (default 1mb, max 100mb)
  """
  return interrupt std::run("Running agent-generated code in subprocess", {
    moduleId: compiled.moduleId,
    node: node,
    args: args,
    limits: { wallClock, memory, ipcPayload, stdout }
  })

  return try _run(compiled, node, args, wallClock, memory, ipcPayload, stdout)
}
```

- [ ] **Step 2.2: Update `_run` TypeScript signature**

In `lib/runtime/ipc.ts`, change the signature:

```ts
export async function _run(
  compiled: { path: string; moduleId: string },
  node: string,
  args: Record<string, any>,
  wallClock: number,
  memory: number,
  ipcPayload: number,
  stdout: number,
  __state: InternalFunctionState,
): Promise<any> {
  // ... existing body, but use `node` and `args` directly instead of `options.node` / `options.args`
}
```

- [ ] **Step 2.3: Update the `_run` AgencyFunction wrapper template**

In `lib/templates/backends/typescriptGenerator/imports.mustache`, change the `_run` line at the bottom from two params (`compiled`, `options`) to seven params:

```ts
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [
  { name: "compiled", hasDefault: false, defaultValue: undefined, variadic: false },
  { name: "node", hasDefault: false, defaultValue: undefined, variadic: false },
  { name: "args", hasDefault: false, defaultValue: undefined, variadic: false },
  { name: "wallClock", hasDefault: false, defaultValue: undefined, variadic: false },
  { name: "memory", hasDefault: false, defaultValue: undefined, variadic: false },
  { name: "ipcPayload", hasDefault: false, defaultValue: undefined, variadic: false },
  { name: "stdout", hasDefault: false, defaultValue: undefined, variadic: false },
], toolDefinition: null }, __toolRegistry);
```

Then run `pnpm run templates` to recompile the `.mustache` to `.ts`.

- [ ] **Step 2.4: Update existing test fixtures (subprocess tests)**

For each of `tests/agency/subprocess/{run-basic,run-with-args,handler-approve,handler-reject,nested-blocked,run-multiple-interrupts,run-crash,run-abnormal-exit}.agency`, replace:

```ts
run(compiled, { node: "main", args: { ... } })
```

with:

```ts
run(compiled, "main", { ... })
```

- [ ] **Step 2.5: Regenerate the typescript builder/generator snapshot fixtures**

Run: `make fixtures`
Expected: the `_run = __AgencyFunction.create(...)` line in every `tests/typescriptBuilder/*.mjs` and `tests/typescriptGenerator/*.mjs` updates to the new param list. Inspect `git diff` to confirm only that line changed everywhere.

- [ ] **Step 2.6: Run all subprocess tests**

Run: `pnpm vitest run tests/agency/subprocess/ 2>&1 | tee /tmp/subprocess-tests.log`
Expected: all pass with the new flat-arg form.

- [ ] **Step 2.7: Run full test suite to catch any other breakage**

Run: `pnpm test:run 2>&1 | tee /tmp/full-tests.log`
Expected: all pass. Read the log even on success — note any new warnings.

- [ ] **Step 2.8: Commit**

```bash
git add stdlib/agency.agency lib/runtime/ipc.ts lib/templates/backends/typescriptGenerator/imports.mustache lib/templates/backends/typescriptGenerator/imports.ts tests/agency/subprocess tests/typescriptBuilder tests/typescriptGenerator
git commit -F- <<'MSG'
refactor!: flatten run() signature for partial application

BREAKING CHANGE: run() no longer accepts an options object.
Parameters are now flat with sensible defaults:

  run(compiled, node, args, wallClock, memory, ipcPayload, stdout)

This composes with named arguments and partial application, letting
parents constrain individual limits before exposing run() as a tool
to an LLM. Limits themselves are not yet enforced — that's the next
commits.
MSG
```

---

## Task 3: Implement cap clamping for limits

**Files:**
- Modify: `lib/runtime/ipc.ts`
- Test: extend Task 9 fixtures (we add a clamp test then)

- [ ] **Step 3.1: Add LIMIT_CEILINGS constant and clamp helper**

In `lib/runtime/ipc.ts`, near the top of the file:

```ts
const LIMIT_CEILINGS = {
  wallClock: 60 * 60 * 1000,           // 1h in ms
  memory: 4 * 1024 * 1024 * 1024,      // 4gb in bytes
  ipcPayload: 1024 * 1024 * 1024,      // 1gb in bytes
  stdout: 100 * 1024 * 1024,           // 100mb in bytes
} as const;

function clampLimits(input: {
  wallClock: number; memory: number; ipcPayload: number; stdout: number;
}): { wallClock: number; memory: number; ipcPayload: number; stdout: number } {
  const out = { ...input };
  for (const key of Object.keys(LIMIT_CEILINGS) as (keyof typeof LIMIT_CEILINGS)[]) {
    if (input[key] > LIMIT_CEILINGS[key]) {
      ipcLog("send", { type: "limit_clamped", limit: key, requested: input[key], clamped: LIMIT_CEILINGS[key] });
      out[key] = LIMIT_CEILINGS[key];
    }
  }
  return out;
}
```

- [ ] **Step 3.2: Apply clamping at the top of `_run`**

In `lib/runtime/ipc.ts`'s `_run`, before the `fork(...)` call:

```ts
const limits = clampLimits({ wallClock, memory, ipcPayload, stdout });
```

Use `limits.wallClock`, `limits.memory`, etc. throughout the body.

- [ ] **Step 3.3: Build and verify clamp logging**

Run: `make` to rebuild.
Run an ad-hoc test:

```bash
cat > /tmp/test-clamp.agency <<'EOF'
import { compile, run } from "std::agency"
node main() {
  const c = compile("node main() { return 42 }")
  if (isFailure(c)) { return "compile failed" }
  return run(c.value, "main", {}, wallClock: 10h, memory: 100gb)
}
EOF
AGENCY_IPC_DEBUG=1 pnpm run agency /tmp/test-clamp.agency 2>&1 | grep "limit_clamped"
# Expected: two limit_clamped lines for wallClock and memory
rm /tmp/test-clamp.agency
```

- [ ] **Step 3.4: Commit**

```bash
git add lib/runtime/ipc.ts
git commit -m "feat(subprocess): clamp limits to hardcoded ceilings"
```

---

## Task 4: Wall-clock enforcement

**Files:**
- Modify: `lib/runtime/ipc.ts`

- [ ] **Step 4.1: Write failing Agency test**

Create `tests/agency/subprocess/limit-wall-clock.agency`:

```ts
import { compile, run } from "std::agency"

node main() {
  const source = """
node main() {
  // Spin forever
  while (true) {}
}
"""
  const c = compile(source)
  if (isFailure(c)) { return "compile failed" }

  handle {
    const result = run(c.value, "main", {}, wallClock: 1s)
    if (isFailure(result)) {
      if (result.error.reason == "limit_exceeded" && result.error.limit == "wall_clock") {
        return "wall_clock limit hit"
      }
      return "wrong failure: " + result.error
    }
    return "unexpected success"
  } with (data) {
    return approve()
  }
}
```

Create `tests/agency/subprocess/limit-wall-clock.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "wall-clock limit kills runaway loop",
      "input": "",
      "expectedOutput": "wall_clock limit hit",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `pnpm run agency test tests/agency/subprocess/limit-wall-clock.agency`
Expected: test hangs or fails (no enforcement yet). If it hangs, kill with Ctrl-C.

- [ ] **Step 4.3: Implement wall-clock enforcement in `_run`**

In `lib/runtime/ipc.ts`, after `child = fork(...)`:

```ts
let wallClockTimer: NodeJS.Timeout | null = setTimeout(() => {
  wallClockTimer = null;
  if (settled) return;
  ipcLog("send", { type: "limit_violation", limit: "wall_clock", value: limits.wallClock, threshold: limits.wallClock });
  settled = true;
  cleanup();
  child.kill("SIGKILL");
  rejectPromise(makeLimitFailure("wall_clock", limits.wallClock, limits.wallClock));
}, limits.wallClock);
```

Add a helper near the top of the file (will be used by all limits):

```ts
function makeLimitFailure(limit: string, threshold: number, value: number, extras: Record<string, any> = {}): Error {
  const err = new Error(`Subprocess exceeded ${limit} limit of ${threshold} (used ${value})`);
  (err as any).limitInfo = {
    reason: "limit_exceeded",
    limit,
    threshold,
    value,
    message: err.message,
    ...extras,
  };
  return err;
}
```

In the `child.on("message", ...)`, `child.on("close", ...)`, and `child.on("error", ...)` handlers, also clear the timer when settling:

```ts
const clearWallClockTimer = () => {
  if (wallClockTimer) { clearTimeout(wallClockTimer); wallClockTimer = null; }
};
```

Call `clearWallClockTimer()` inside each `if (!settled) { settled = true; ... }` block.

You'll also need to surface `limitInfo` as a structured failure value. Update the call site of `_run` (or convert to `Result` here) so that the Agency-side `run()` sees a real `failure({reason: "limit_exceeded", ...})` object. Note: the current `_run` throws and the Agency `try` keyword wraps it. Inspect the output of `try` for an Error with `limitInfo` and propagate the structured value.

The cleanest path: change `_run`'s rejection from `new Error(...)` to a structured rejection that the Agency `try` keyword already catches as a failure with the error's properties. Verify the existing `try _run(...)` path produces a failure value where `failure.error` is the Error message string. We need richer structure — likely the cleanest approach is to make `_run` return a Result-shape object for limit violations rather than throwing:

```ts
// Resolve, don't reject, so Agency-side try doesn't lose the structure
resolvePromise({
  __limitFailure: true,
  reason: "limit_exceeded",
  limit, threshold, value, message,
});
```

Then in the Agency stdlib `run()`, check for `__limitFailure` and convert to a real `failure(...)`. Or: read the existing `try` keyword codegen to find a cleaner way to thread structured errors. Use whichever is cleanest for the codebase — see [docs/dev/anti-patterns.md](../../dev/anti-patterns.md) for guidance on Result handling.

- [ ] **Step 4.4: Run test to verify it passes**

Run: `make && pnpm run agency test tests/agency/subprocess/limit-wall-clock.agency`
Expected: test passes within ~1.5s (well under default 60s timeout).

- [ ] **Step 4.5: Verify clean shutdown**

Manually run a long-but-completing subprocess to verify the timer is cleared correctly:

```bash
cat > /tmp/test-wall-noop.agency <<'EOF'
import { compile, run } from "std::agency"
node main() {
  const c = compile("node main() { return 42 }")
  return run(c.value, "main", {}, wallClock: 60s)
}
EOF
AGENCY_IPC_DEBUG=1 pnpm run agency /tmp/test-wall-noop.agency 2>&1 | grep -i "wall_clock\|timer"
# Expected: no wall_clock violation logged; result returns 42 quickly
rm /tmp/test-wall-noop.agency
```

- [ ] **Step 4.6: Commit**

```bash
git add lib/runtime/ipc.ts tests/agency/subprocess/limit-wall-clock.agency tests/agency/subprocess/limit-wall-clock.test.json
git commit -m "feat(subprocess): enforce wallClock limit with SIGKILL"
```

---

## Task 5: Memory enforcement

**Files:**
- Modify: `lib/runtime/ipc.ts`

- [ ] **Step 5.1: Write failing Agency test**

Create `tests/agency/subprocess/limit-memory.agency`:

```ts
import { compile, run } from "std::agency"

node main() {
  const source = """
node main() {
  // Allocate ~200mb of strings to blow past 50mb V8 heap limit
  let s = "x"
  for (i in range(0, 25)) {
    s = s + s + s
  }
  return s.length
}
"""
  const c = compile(source)
  if (isFailure(c)) { return "compile failed" }

  handle {
    const result = run(c.value, "main", {}, memory: 64mb)
    if (isFailure(result)) {
      if (result.error.reason == "limit_exceeded" && result.error.limit == "memory") {
        return "memory limit hit"
      }
      return "wrong failure: " + result.error
    }
    return "unexpected success"
  } with (data) {
    return approve()
  }
}
```

Create the matching `.test.json` with `expectedOutput: "memory limit hit"`.

- [ ] **Step 5.2: Run test to verify it fails**

Run: `pnpm run agency test tests/agency/subprocess/limit-memory.agency`
Expected: failure (the limit isn't applied yet). Test currently returns "unexpected success" or a generic crash failure.

- [ ] **Step 5.3: Pass `--max-old-space-size` via `execArgv`**

In `lib/runtime/ipc.ts`, change the `fork(...)` call:

```ts
const memoryMb = Math.max(1, Math.floor(limits.memory / (1024 * 1024)));
const child = fork(subprocessBootstrapPath, [], {
  stdio: ["pipe", "inherit", "inherit", "ipc"],
  env: { ...process.env, AGENCY_IPC: "1" },
  execArgv: [`--max-old-space-size=${memoryMb}`],
});
```

- [ ] **Step 5.4: Detect OOM in close handler and convert to limit failure**

In `child.on("close", ...)`:

```ts
child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
  if (settled) return;
  settled = true;
  clearWallClockTimer();
  cleanup();

  // V8 OOM exits with code 134 on Unix or via SIGABRT
  // Conservatively check both signals: SIGABRT (OOM), SIGKILL (we killed it)
  const isLikelyOom = code === 134 || signal === "SIGABRT";
  if (isLikelyOom) {
    rejectPromise(makeLimitFailure("memory", limits.memory, limits.memory));
  } else {
    rejectPromise(new Error(`Subprocess exited unexpectedly with code ${code} signal ${signal}`));
  }
});
```

(Verify exit code 134 vs 134-with-signal-name on macOS by running an OOM subprocess manually first.)

- [ ] **Step 5.5: Run test to verify it passes**

Run: `make && pnpm run agency test tests/agency/subprocess/limit-memory.agency`
Expected: passes. The subprocess crashes with OOM, parent reports "memory limit hit".

- [ ] **Step 5.6: Commit**

```bash
git add lib/runtime/ipc.ts tests/agency/subprocess/limit-memory.agency tests/agency/subprocess/limit-memory.test.json
git commit -m "feat(subprocess): enforce memory limit via --max-old-space-size"
```

---

## Task 6: IPC payload enforcement

**Files:**
- Modify: `lib/runtime/ipc.ts` (parent side)
- Modify: `lib/runtime/subprocess-bootstrap.ts` (child side)

- [ ] **Step 6.1: Write failing Agency test**

Create `tests/agency/subprocess/limit-ipc-payload.agency`:

```ts
import { compile, run } from "std::agency"

node main() {
  const source = """
node main() {
  // Return a 5mb string
  let s = "x"
  for (i in range(0, 23)) {
    s = s + s
  }
  return s
}
"""
  const c = compile(source)
  if (isFailure(c)) { return "compile failed" }

  handle {
    const result = run(c.value, "main", {}, ipcPayload: 1mb)
    if (isFailure(result)) {
      if (result.error.reason == "limit_exceeded" && result.error.limit == "ipc_payload") {
        return "ipc_payload limit hit"
      }
      return "wrong failure: " + result.error
    }
    return "unexpected success"
  } with (data) {
    return approve()
  }
}
```

`.test.json` with `expectedOutput: "ipc_payload limit hit"`.

- [ ] **Step 6.2: Run test to verify it fails**

Run: `pnpm run agency test tests/agency/subprocess/limit-ipc-payload.agency`
Expected: failure (limit not enforced yet).

- [ ] **Step 6.3: Pass `ipcPayload` to the bootstrap via the run instruction**

In `lib/runtime/ipc.ts`, the run instruction currently is:

```ts
const runMsg = { mode: "run", scriptPath, node, args };
```

Add `ipcPayload`:

```ts
const runMsg = { mode: "run", scriptPath: compiled.path, node, args, ipcPayload: limits.ipcPayload };
```

- [ ] **Step 6.4: Child-side check before sending result**

In `lib/runtime/subprocess-bootstrap.ts`, store the ipcPayload limit when received:

```ts
let ipcPayloadLimit = Infinity;

const bootstrapHandler = async (msg: RunInstruction) => {
  // ...
  ipcPayloadLimit = msg.ipcPayload ?? Infinity;
  // ...
};
```

Wrap the result send:

```ts
const resultMsg: IpcResultMessage = { type: "result", value: { data: result.data, tokens: result.tokens, messages: ... } };
const serialized = JSON.stringify(resultMsg);
if (serialized.length > ipcPayloadLimit) {
  const samplePrefix = serialized.slice(0, 1024);
  const errMsg = {
    type: "error",
    error: JSON.stringify({
      reason: "limit_exceeded",
      limit: "ipc_payload",
      threshold: ipcPayloadLimit,
      value: serialized.length,
      message: `Result payload (${serialized.length} bytes) exceeded ipcPayload limit of ${ipcPayloadLimit}`,
      samplePrefix,
    }),
  };
  process.send!(errMsg);
  process.exit(1);
}
process.send!(resultMsg);
```

- [ ] **Step 6.5: Parent-side check on incoming messages**

In `lib/runtime/ipc.ts`'s `child.on("message", async (msg) => { ... })`, at the top:

```ts
const serialized = JSON.stringify(msg);
if (serialized.length > limits.ipcPayload) {
  if (settled) return;
  settled = true;
  clearWallClockTimer();
  child.kill("SIGKILL");
  cleanup();
  rejectPromise(makeLimitFailure("ipc_payload", limits.ipcPayload, serialized.length, {
    samplePrefix: serialized.slice(0, 1024),
  }));
  return;
}
```

When the parent receives an `error` message whose `error` field parses as JSON containing `reason: "limit_exceeded"`, propagate it as a structured limit failure rather than a generic error:

```ts
} else if (msg.type === "error") {
  if (!settled) {
    settled = true;
    clearWallClockTimer();
    cleanup();
    let parsed: any = null;
    try { parsed = JSON.parse(msg.error); } catch (_) {}
    if (parsed?.reason === "limit_exceeded") {
      rejectPromise(makeLimitFailure(parsed.limit, parsed.threshold, parsed.value, { samplePrefix: parsed.samplePrefix }));
    } else {
      rejectPromise(new Error(msg.error));
    }
  }
}
```

- [ ] **Step 6.6: Run test to verify it passes**

Run: `make && pnpm run agency test tests/agency/subprocess/limit-ipc-payload.agency`
Expected: passes.

- [ ] **Step 6.7: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/subprocess-bootstrap.ts tests/agency/subprocess/limit-ipc-payload.agency tests/agency/subprocess/limit-ipc-payload.test.json
git commit -m "feat(subprocess): enforce ipcPayload limit on both sides"
```

---

## Task 7: Stdout/stderr enforcement with truncation

**Files:**
- Modify: `lib/runtime/ipc.ts`

- [ ] **Step 7.1: Write failing Agency test**

Create `tests/agency/subprocess/limit-stdout.agency`:

```ts
import { compile, run } from "std::agency"

node main() {
  const source = """
node main() {
  // Print 5mb of output
  let s = "x"
  for (i in range(0, 23)) {
    s = s + s
  }
  print(s)
  return "done"
}
"""
  const c = compile(source)
  if (isFailure(c)) { return "compile failed" }

  handle {
    const result = run(c.value, "main", {}, stdout: 1mb)
    if (isFailure(result)) {
      if (result.error.reason == "limit_exceeded" && result.error.limit == "stdout") {
        return "stdout limit hit"
      }
      return "wrong failure: " + result.error
    }
    return "unexpected success"
  } with (data) {
    return approve()
  }
}
```

`.test.json` with `expectedOutput: "stdout limit hit"`.

- [ ] **Step 7.2: Run test to verify it fails**

Run: `pnpm run agency test tests/agency/subprocess/limit-stdout.agency`
Expected: returns "unexpected success" (no enforcement yet).

- [ ] **Step 7.3: Switch stdio to pipe and add byte-counting forwarder**

In `lib/runtime/ipc.ts`, change:

```ts
stdio: ["pipe", "inherit", "inherit", "ipc"],
```

to:

```ts
stdio: ["pipe", "pipe", "pipe", "ipc"],
```

After the `fork(...)` call, set up forwarders for `child.stdout` and `child.stderr`:

```ts
let stdoutBytes = 0;
let stoppedForwarding = false;

const makeForwarder = (src: NodeJS.ReadableStream, dst: NodeJS.WriteStream) => {
  src.on("data", (chunk: Buffer) => {
    if (stoppedForwarding) return;
    const remaining = limits.stdout - stdoutBytes;
    if (chunk.length <= remaining) {
      stdoutBytes += chunk.length;
      dst.write(chunk);
    } else {
      // Write the part that fits, then truncation marker, then stop
      if (remaining > 0) dst.write(chunk.subarray(0, remaining));
      stdoutBytes = limits.stdout;
      dst.write(`\n... [output truncated: stdout limit of ${limits.stdout} bytes exceeded]\n`);
      stoppedForwarding = true;

      if (settled) return;
      settled = true;
      clearWallClockTimer();
      child.kill("SIGKILL");
      cleanup();
      rejectPromise(makeLimitFailure("stdout", limits.stdout, stdoutBytes));
    }
  });
};

if (child.stdout) makeForwarder(child.stdout, process.stdout);
if (child.stderr) makeForwarder(child.stderr, process.stderr);
```

- [ ] **Step 7.4: Run test to verify it passes**

Run: `make && pnpm run agency test tests/agency/subprocess/limit-stdout.agency`
Expected: passes. Visually inspect the output to confirm the truncation marker is printed before the kill.

- [ ] **Step 7.5: Run all subprocess tests to verify pipe-mode regression**

Run: `pnpm vitest run tests/agency/subprocess/ 2>&1 | tee /tmp/subprocess-after-stdout.log`
Expected: all 8 pre-existing + 4 new tests pass. Existing tests must still see their `print()` output (now pipes through parent stdout).

- [ ] **Step 7.6: Commit**

```bash
git add lib/runtime/ipc.ts tests/agency/subprocess/limit-stdout.agency tests/agency/subprocess/limit-stdout.test.json
git commit -m "feat(subprocess): enforce stdout/stderr volume limit with truncation marker"
```

---

## Task 8: Cap-clamping test + partial-application test

**Files:**
- Create: `tests/agency/subprocess/limit-cap-clamping.agency` + `.test.json`
- Create: `tests/agency/subprocess/limit-partial-application.agency` + `.test.json`

- [ ] **Step 8.1: Write cap-clamping test**

`tests/agency/subprocess/limit-cap-clamping.agency`:

```ts
import { compile, run } from "std::agency"

node main() {
  const source = """
node main() {
  while (true) {}
}
"""
  const c = compile(source)
  if (isFailure(c)) { return "compile failed" }

  handle {
    // Request 10h wallClock — should be clamped to 1h ceiling
    // But we'll trigger it with a 1s wait to verify clamping doesn't bypass enforcement
    const result = run(c.value, "main", {}, wallClock: 10h)
    if (isFailure(result)) {
      if (result.error.reason == "limit_exceeded" && result.error.limit == "wall_clock") {
        // Threshold should have been clamped to 3600000ms (1h), not 36000000ms (10h)
        if (result.error.threshold == 3600000) {
          return "clamped"
        }
        return "wrong threshold: " + result.error.threshold
      }
    }
    return "wrong outcome"
  } with (data) {
    return approve()
  }
}
```

`.test.json` with `expectedOutput: "clamped"`.

This test will sit idle for 1 hour before the wall-clock kicks in — that's too slow for CI. So instead, write the test to verify clamping by inspecting the failure threshold for a low value (e.g., set `wallClock: 1s`, confirm `threshold == 1000`), and add a separate fast unit test in TypeScript that calls `clampLimits` directly:

In `lib/runtime/ipc.test.ts` (create it):

```ts
import { describe, it, expect } from "vitest";
// Import clampLimits — may need to export it from ipc.ts
import { clampLimits } from "./ipc.js";

describe("clampLimits", () => {
  it("clamps wallClock above 1h to 1h", () => {
    const out = clampLimits({ wallClock: 10 * 60 * 60 * 1000, memory: 1, ipcPayload: 1, stdout: 1 });
    expect(out.wallClock).toBe(60 * 60 * 1000);
  });

  it("clamps memory above 4gb to 4gb", () => {
    const out = clampLimits({ wallClock: 1, memory: 8 * 1024 * 1024 * 1024, ipcPayload: 1, stdout: 1 });
    expect(out.memory).toBe(4 * 1024 * 1024 * 1024);
  });

  it("leaves below-ceiling values unchanged", () => {
    const out = clampLimits({ wallClock: 30000, memory: 256 * 1024 * 1024, ipcPayload: 1024, stdout: 512 });
    expect(out).toEqual({ wallClock: 30000, memory: 256 * 1024 * 1024, ipcPayload: 1024, stdout: 512 });
  });
});
```

Export `clampLimits` from `ipc.ts` if not already.

- [ ] **Step 8.2: Run TypeScript clamp test**

Run: `pnpm vitest run lib/runtime/ipc.test.ts`
Expected: 3 tests pass.

- [ ] **Step 8.3: Write partial-application test**

`tests/agency/subprocess/limit-partial-application.agency`:

```ts
import { compile, run } from "std::agency"

node main() {
  const source = "node main() { while (true) {} }"
  const c = compile(source)
  if (isFailure(c)) { return "compile failed" }

  // Bind a tight wallClock via partial application
  const safeRun = run.partial(compiled: c.value, wallClock: 1s)

  handle {
    const result = safeRun(node: "main", args: {})
    if (isFailure(result)) {
      if (result.error.reason == "limit_exceeded" && result.error.limit == "wall_clock") {
        return "partial-applied limit hit"
      }
      return "wrong failure"
    }
    return "unexpected success"
  } with (data) {
    return approve()
  }
}
```

`.test.json` with `expectedOutput: "partial-applied limit hit"`.

- [ ] **Step 8.4: Run partial-application test**

Run: `pnpm run agency test tests/agency/subprocess/limit-partial-application.agency`
Expected: passes within ~1.5s.

- [ ] **Step 8.5: Commit**

```bash
git add tests/agency/subprocess/limit-cap-clamping.agency tests/agency/subprocess/limit-cap-clamping.test.json tests/agency/subprocess/limit-partial-application.agency tests/agency/subprocess/limit-partial-application.test.json lib/runtime/ipc.test.ts lib/runtime/ipc.ts
git commit -m "test(subprocess): clamping unit test + partial-application integration test"
```

---

## Task 9: Documentation and cleanup

**Files:**
- Modify: `docs-new/stdlib/agency.md` (regenerated)
- Modify: `docs-new/guide/` — possibly add a section on subprocess limits if there's a relevant guide page
- Verify: spec doc references the implementation correctly

- [ ] **Step 9.1: Regenerate stdlib docs**

Run: `make`
Expected: `docs-new/stdlib/agency.md` updates to show the new flat signature with limits and their defaults.

- [ ] **Step 9.2: Inspect and commit the regenerated doc**

Run: `git diff docs-new/stdlib/agency.md`
Expected: shows the new `run()` signature with all four limit parameters and their defaults visible.

```bash
git add docs-new/stdlib/agency.md
git commit -m "docs(stdlib): regenerate agency.md with new run() signature"
```

- [ ] **Step 9.3: Run the full test suite one more time**

Run: `pnpm test:run 2>&1 | tee /tmp/full-tests-final.log`
Expected: all green. Inspect the log for any new warnings or skipped tests.

- [ ] **Step 9.4: Run the structural linter**

Run: `pnpm run lint:structure 2>&1 | tee /tmp/lint.log`
Expected: clean.

- [ ] **Step 9.5: Update the unplanned section of the original subprocess design doc (optional)**

If you discovered any issues during implementation that weren't anticipated, add them to the "Unplanned/Unplanned" section of `docs/superpowers/specs/2026-05-07-subprocess-ipc-handler-propagation-design.md` for future implementers, following the existing format.

---

## Out of scope / explicit non-goals

These are documented in the spec under Non-goals. Do **not** implement:

- CPU-time limits or heartbeat protocol
- RSS-based memory limits
- Network or filesystem limits
- Per-tool budgets
- Per-stream stdout vs stderr split limits
- Config-file caps in `agency.json`

If implementation reveals one of these is critical, surface it before implementing — the design intentionally excludes them.

---

## Verification checklist (run before merging)

- [ ] All 12 subprocess test fixtures pass (`pnpm vitest run tests/agency/subprocess/`)
- [ ] Full test suite passes (`pnpm test:run`)
- [ ] Structural linter passes (`pnpm run lint:structure`)
- [ ] `AGENCY_IPC_DEBUG=1 pnpm run agency tests/agency/subprocess/limit-wall-clock.agency` shows the `limit_violation` log line
- [ ] `make` regenerates `docs-new/stdlib/agency.md` cleanly
- [ ] Spec is referenced from this plan and vice versa
- [ ] PR description calls out the breaking change to `run()` signature
