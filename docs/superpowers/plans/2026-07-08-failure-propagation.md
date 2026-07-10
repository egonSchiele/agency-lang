# Failure Propagation at Call Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. (Owner preference: no subagent-driven development; work inline in the main session.) Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failure Result passed to a parameter not typed to accept Results skips the callee and propagates the original failure; failures into plain TypeScript functions and method calls on Results throw rich errors.

**Architecture:** Codegen stamps a per-param `acceptsResult` boolean onto `FuncParam` (mirroring the existing `isFunctionTyped` flag). `AgencyFunction.invoke()` scans resolved arguments and short-circuits, returning a clone of the failure with a `skippedFunctions` trail appended. The `__call`/`__callMethod` dispatchers gain the TypeScript-function and method-call checks. A `failurePropagation` config knob (`"off" | "warn" | "on"`) is plumbed like `maxCallDepth`.

**Tech Stack:** TypeScript runtime (`lib/runtime/`), tarsec-parsed AST types, vitest unit tests, Agency execution tests (`tests/agency/`).

**Spec:** `docs/superpowers/specs/2026-07-08-failure-propagation-design.md` (same branch). Read it before starting.

## Staging: two PRs

This lands as two PRs, following the repo's measure-then-flip playbook (`matchExhaustiveness`, `strictMemberAccess`):

- **Stage 1 (Tasks 1–9, PR #1): the full mechanism, defaulting to `"warn"`.** Every check runs and logs; nothing skips or throws unless a program opts in with `failurePropagation: "on"`. Zero behavior change for existing programs, so CI stays green by construction. The strict behavior is still fully tested in Stage 1: unit tests exercise it directly (the frameless fallback is `"on"`), and an agency-js test opts a compiled program into `"on"` end to end.
- **Stage 2 (Tasks 10–12, PR #2): flip the default to `"on"`.** A one-line diff in `ExecutionContext`, plus the execution tests and docs that depend on the strict default. PR #2's CI run over the 841-program corpus is the measurement; its triage protocol is in Task 12. If the flip misbehaves in the wild, reverting PR #2 alone turns the strictness off without ripping out the machinery.

Two defaults exist on purpose, and only one flips:

| Where | Applies to | Stage 1 | Stage 2 |
|---|---|---|---|
| `getFailurePropagationMode()` fallback (no execution frame) | bare unit tests, direct runtime callers | `"on"` | `"on"` |
| `ExecutionContext` constructor default | every real compiled program | `"warn"` | `"on"` |

Stage 2 starts only after PR #1 is merged, in a fresh worktree branched off updated main.

## Global Constraints

- Work in this worktree on branch `failure-propagation-spec` for Stage 1. Stage 2 gets its own worktree + branch off updated main after PR #1 merges. NEVER commit to main.
- All paths below are relative to `packages/agency-lang/` unless they start with `docs/`.
- Run `make` after changing stdlib `.agency` files or before running Agency execution tests that depend on runtime changes.
- Save all test output to a log file (`2>&1 | tee /tmp/fp-<task>.log`) — do not rerun expensive tests just to re-read failures.
- Do NOT run the full Agency test suite locally. Run only the specific tests named in each task. CI runs the full corpus on the PR.
- Thrown errors introduced by this feature MUST be plain `Error`, never `AgencyAbort` (the auto-try re-throws aborts; a plain Error becomes a catchable failure of the enclosing function).
- Legacy `FuncParam` values without `acceptsResult` must fail open (accept failures). Only `acceptsResult === false` rejects.
- Unannotated Agency params reject failures; explicit `any`, `Result`, `Result<...>`, or a union containing either accepts. A `typeAliasVariable` hint (e.g. `type MyR = Result`) rejects in v1 — known limitation, do not resolve aliases.
- Node transitions are OUT of scope (spec decision). Do not touch `generateNodeCallExpression`.
- Block params ALWAYS fail open in v1 (deliberate carve-out, plan-review finding 2): both block emission sites (`typescriptBuilder.ts:1645` and `:1690`) emit params as `{ name }` only — do NOT add `acceptsResult` there. Blocks iterate arrays that legitimately contain Results; the method-call check still catches misuse inside the block body.
- The TS-function argument scan lives in `__call` ONLY, never in `__callMethod` (plan-review finding 1): scanning method arguments would break `arr.push(someFailure)` and every other native-prototype call that legitimately receives failures.
- No backward-compatibility handling for pre-feature serialized failures (spec decision). `failure()` is the single initializer of `skippedFunctions`; do not write `?? []` fallbacks.
- Style (structural linter enforces): brace every `if` body, use `Object.hasOwn` (not `hasOwnProperty.call`), no nested ternaries, no single-character identifiers outside conventional fixtures.
- Commit messages: write to a file first, then `git commit -F <file>` (apostrophes break inline `-m`).

---

## Stage 1: the mechanism, shipping default "warn"

### Task 1: `skippedFunctions` field and `propagateFailure` helper

**Files:**
- Modify: `lib/runtime/result.ts` (type `ResultFailure` ~line 65, function `failure` ~line 79)
- Create: `lib/runtime/failurePropagation.test.ts`

**Interfaces:**
- Consumes: existing `ResultFailure`, `failure()` from `lib/runtime/result.ts`.
- Produces: `type SkippedFunction = { name: string; param: string }`; `ResultFailure.skippedFunctions: SkippedFunction[]`; `propagateFailure(orig: ResultFailure, skipped: SkippedFunction): ResultFailure` — all exported from `lib/runtime/result.ts`. Tasks 2–5 rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/failurePropagation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { failure, propagateFailure } from "./result.js";

describe("propagateFailure", () => {
  it("failure() initializes skippedFunctions to an empty array", () => {
    const f = failure("boom");
    expect(f.skippedFunctions).toEqual([]);
  });

  it("appends a skip entry, preserving every other field, without mutating the original", () => {
    const orig = failure("boom", {
      functionName: "getReport",
      retryable: true,
      checkpoint: { step: 3 },
      args: { id: "abc" },
    });
    const propagated = propagateFailure(orig, { name: "wordCount", param: "text" });
    expect(propagated.skippedFunctions).toEqual([{ name: "wordCount", param: "text" }]);
    expect(propagated.error).toBe("boom");
    expect(propagated.functionName).toBe("getReport");
    expect(propagated.retryable).toBe(true);
    expect(propagated.checkpoint).toEqual({ step: 3 });
    expect(propagated.args).toEqual({ id: "abc" });
    expect(orig.skippedFunctions).toEqual([]);
  });

  it("accumulates entries across hops", () => {
    const orig = failure("boom");
    const hop1 = propagateFailure(orig, { name: "a", param: "x" });
    const hop2 = propagateFailure(hop1, { name: "b", param: "y" });
    expect(hop2.skippedFunctions).toEqual([
      { name: "a", param: "x" },
      { name: "b", param: "y" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/failurePropagation.test.ts 2>&1 | tee /tmp/fp-task1.log`
Expected: FAIL — `propagateFailure` is not exported.

- [ ] **Step 3: Implement**

In `lib/runtime/result.ts`:

Add above `ResultFailure`:

```ts
/** One hop in a propagated failure's journey: the function whose body was
 *  skipped and the parameter that rejected the failure. */
export type SkippedFunction = { name: string; param: string };
```

Add to the `ResultFailure` type (after `args`):

```ts
  skippedFunctions: SkippedFunction[];
```

Add to the object literal returned by `failure()` (after `args`):

```ts
    skippedFunctions: [],
```

Add after `failure()`:

```ts
/** Shallow-clone a failure with one more skip entry. Used by the
 *  failure-propagation check when a call short-circuits: the ORIGINAL
 *  failure's error/functionName/args survive untouched so the origin is
 *  never hidden. `failure()` is the single initializer of
 *  skippedFunctions — no `?? []` fallback here (spec: no backward-compat
 *  handling for pre-feature serialized failures). */
export function propagateFailure(
  orig: ResultFailure,
  skipped: SkippedFunction,
): ResultFailure {
  return {
    ...orig,
    skippedFunctions: [...orig.skippedFunctions, skipped],
  };
}
```

- [ ] **Step 4: Run test and fix any compile fallout**

Run: `pnpm test:run lib/runtime/failurePropagation.test.ts 2>&1 | tee /tmp/fp-task1.log`
Expected: PASS.

Then run: `make 2>&1 | tee /tmp/fp-task1-build.log`
Expected: clean build. If TypeScript reports other files constructing `ResultFailure` object literals without the new field, add `skippedFunctions: []` to each (or route them through `failure()` if trivially possible).

- [ ] **Step 5: Commit**

```bash
git add -A lib
printf 'runtime: add skippedFunctions field and propagateFailure helper\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 2: `failurePropagation` runtime module + statelog warn event

**Files:**
- Create: `lib/runtime/failurePropagation.ts`
- Create: `lib/runtime/truncate.ts` (extracted from `ipc.ts`)
- Modify: `lib/runtime/ipc.ts` (delete its private `truncate`, import the extracted one)
- Modify: `lib/statelogClient.ts` (add `warn()` right after `error()`, ~line 1147)
- Modify: `lib/runtime/index.ts` (export `acceptsFailures`)
- Modify: `lib/stdlib/builtins.ts` (tag `_print`, `_printJSON`)
- Test: `lib/runtime/failurePropagation.test.ts` (extend)

**Interfaces:**
- Consumes: `isFailure`, `isSuccess`, `propagateFailure`, `ResultFailure` from `./result.js`; `agencyStore` from `./asyncContext.js`; `FuncParam` (type-only) from `./agencyFunction.js`.
- Produces, all exported from `lib/runtime/failurePropagation.ts`:
  - `type FailurePropagationMode = "off" | "warn" | "on"`
  - `getFailurePropagationMode(): FailurePropagationMode` (reads `agencyStore.getStore()?.ctx?.failurePropagation ?? "on"`)
  - `acceptsFailures<T extends (...args: any[]) => any>(fn: T): T`
  - `isFailureTolerant(fn: unknown): boolean`
  - `checkFailureArgs(fnName: string, params: FuncParam[], args: unknown[]): ResultFailure | null`
  - `checkTsFunctionArgs(target: Function, fnName: string, args: unknown[]): void`
  - `checkResultMethodCall(obj: unknown, prop: string | number): void`
  - `describeFailureCallTarget(f: ResultFailure): string`
- Also produces: `StatelogClient.warn({ warnType, message, functionName, param, error })`.

Import-cycle note: `agencyFunction.ts` (Task 3) will import this module, and this module imports `FuncParam` from `agencyFunction.ts` — that import MUST be `import type` so no runtime cycle exists. Do not import the `UNSET` symbol; `isFailure(UNSET)` is false, so UNSET slots need no special handling. Do not import the `AgencyFunction` class either; detect it structurally via `(v as any)?.__agencyFunction === true`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/runtime/failurePropagation.test.ts`:

```ts
import {
  acceptsFailures,
  isFailureTolerant,
  checkFailureArgs,
  checkTsFunctionArgs,
  checkResultMethodCall,
  getFailurePropagationMode,
} from "./failurePropagation.js";
import { isFailure, isSuccess, success } from "./result.js";
import { agencyStore } from "./asyncContext.js";
import type { FuncParam } from "./agencyFunction.js";

function param(name: string, opts: Partial<FuncParam> = {}): FuncParam {
  return { name, hasDefault: false, defaultValue: undefined, variadic: false, ...opts };
}

describe("mode resolution", () => {
  it("defaults to 'on' outside an execution frame", () => {
    expect(getFailurePropagationMode()).toBe("on");
  });
});

describe("acceptsFailures / isFailureTolerant", () => {
  it("tags a function and returns it", () => {
    const fn = (x: unknown) => x;
    expect(acceptsFailures(fn)).toBe(fn);
    expect(isFailureTolerant(fn)).toBe(true);
  });

  it("untagged functions are not tolerant; JSON.stringify is by identity", () => {
    expect(isFailureTolerant((x: unknown) => x)).toBe(false);
    expect(isFailureTolerant(JSON.stringify)).toBe(true);
    expect(isFailureTolerant("not a function")).toBe(false);
  });

  it("isSuccess/isFailure/success/failure ship pre-tagged (aliased use routes through __call)", () => {
    expect(isFailureTolerant(isSuccess)).toBe(true);
    expect(isFailureTolerant(isFailure)).toBe(true);
    expect(isFailureTolerant(success)).toBe(true);
    expect(isFailureTolerant(failure)).toBe(true);
  });
});

describe("checkFailureArgs", () => {
  const f = failure("boom", { functionName: "origin" });

  it("propagates when a rejecting param receives a failure", () => {
    const out = checkFailureArgs("target", [param("x", { acceptsResult: false })], [f]);
    expect(out).not.toBeNull();
    expect(out!.error).toBe("boom");
    expect(out!.skippedFunctions).toEqual([{ name: "target", param: "x" }]);
  });

  it("returns null for accepting params, legacy params, and non-failure args", () => {
    expect(checkFailureArgs("t", [param("x", { acceptsResult: true })], [f])).toBeNull();
    expect(checkFailureArgs("t", [param("x")], [f])).toBeNull(); // legacy fails open
    expect(checkFailureArgs("t", [param("x", { acceptsResult: false })], ["str"])).toBeNull();
    expect(checkFailureArgs("t", [param("x", { acceptsResult: false })], [success(1)])).toBeNull();
  });

  it("leftmost failure wins", () => {
    const g = failure("second");
    const out = checkFailureArgs(
      "t",
      [param("a", { acceptsResult: false }), param("b", { acceptsResult: false })],
      [f, g],
    );
    expect(out!.error).toBe("boom");
    expect(out!.skippedFunctions[0].param).toBe("a");
  });

  it("leftmost means leftmost REJECTING param: a failure on an accepting param is ignored", () => {
    const g = failure("second");
    const out = checkFailureArgs(
      "mix",
      [param("a", { acceptsResult: true }), param("b", { acceptsResult: false })],
      [f, g],
    );
    expect(out!.error).toBe("second");
    expect(out!.skippedFunctions).toEqual([{ name: "mix", param: "b" }]);
  });

  it("checks elements of a variadic param", () => {
    const out = checkFailureArgs(
      "t",
      [param("items", { variadic: true, acceptsResult: false })],
      [["ok", f]],
    );
    expect(out!.error).toBe("boom");
    expect(out!.skippedFunctions).toEqual([{ name: "t", param: "items" }]);
  });

  it("a failure nested in an array arg of a non-variadic param passes (shallow check)", () => {
    expect(checkFailureArgs("t", [param("x", { acceptsResult: false })], [[f]])).toBeNull();
  });

  it("emits a statelog warn event on skip", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "on",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
      const out = checkFailureArgs("t", [param("x", { acceptsResult: false })], [f]);
      expect(out).not.toBeNull();
    });
    expect(events).toHaveLength(1);
    expect(events[0].warnType).toBe("failurePropagation");
    expect(events[0].functionName).toBe("t");
    expect(events[0].param).toBe("x");
  });

  it("warn mode logs but does not propagate", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "warn",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
      const out = checkFailureArgs("t", [param("x", { acceptsResult: false })], [f]);
      expect(out).toBeNull();
    });
    expect(events).toHaveLength(1);
  });

  it("warn mode is a census: every rejecting hit logs, not just the leftmost", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "warn",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
      checkFailureArgs(
        "t",
        [param("a", { acceptsResult: false }), param("b", { acceptsResult: false })],
        [f, failure("second")],
      );
    });
    expect(events).toHaveLength(2);
  });

  it("off mode neither logs nor propagates", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "off",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
      const out = checkFailureArgs("t", [param("x", { acceptsResult: false })], [f]);
      expect(out).toBeNull();
    });
    expect(events).toHaveLength(0);
  });
});

describe("checkTsFunctionArgs", () => {
  const f = failure("boom", { functionName: "origin" });

  it("throws a plain Error naming the producer for untagged functions", () => {
    const target = function formatDate() {};
    expect(() => checkTsFunctionArgs(target, "formatDate", [f])).toThrowError(
      /formatDate.*failure.*origin/s,
    );
  });

  it("does not throw for tagged functions or non-failure args", () => {
    const tolerant = acceptsFailures(function logIt() {});
    expect(() => checkTsFunctionArgs(tolerant, "logIt", [f])).not.toThrow();
    const target = function formatDate() {};
    expect(() => checkTsFunctionArgs(target, "formatDate", ["x", 1])).not.toThrow();
  });

  it("a success arg does not throw (the check is failure-only)", () => {
    const target = function formatDate() {};
    expect(() => checkTsFunctionArgs(target, "formatDate", [success(1)])).not.toThrow();
  });

  it("warn mode logs without throwing; off mode does neither", () => {
    const target = function formatDate() {};
    for (const [mode, expectedLogs] of [["warn", 1], ["off", 0]] as const) {
      const events: any[] = [];
      const ctx: any = {
        failurePropagation: mode,
        statelogClient: { warn: (e: any) => { events.push(e); } },
      };
      agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
        expect(() => checkTsFunctionArgs(target, "formatDate", [f])).not.toThrow();
      });
      expect(events).toHaveLength(expectedLogs);
    }
  });
});

describe("checkResultMethodCall", () => {
  it("throws for a method call on a failure, naming the producer", () => {
    const f = failure("nope", { functionName: "getF" });
    expect(() => checkResultMethodCall(f, "split")).toThrowError(/split.*failure.*getF/s);
  });

  it("throws for a method call on a success, with the .value hint", () => {
    expect(() => checkResultMethodCall(success(5), "toFixed")).toThrowError(/\.value\./);
  });

  it("allows own-field callables (r.value holding a function or AgencyFunction)", () => {
    expect(() => checkResultMethodCall(success(() => 1), "value")).not.toThrow();
    const agencyLike = { __agencyFunction: true };
    expect(() => checkResultMethodCall(success(agencyLike), "value")).not.toThrow();
  });

  it("an own field that is NOT callable still throws (f.error() where error is a string)", () => {
    const f = failure("nope", { functionName: "getF" });
    expect(() => checkResultMethodCall(f, "error")).toThrowError(/error.*getF/s);
  });

  it("ignores non-Result objects", () => {
    expect(() => checkResultMethodCall({ split: undefined }, "split")).not.toThrow();
    expect(() => checkResultMethodCall("plain string", "split")).not.toThrow();
  });

  it("warn mode logs without throwing; off mode does neither", () => {
    const f = failure("nope", { functionName: "getF" });
    for (const [mode, expectedLogs] of [["warn", 1], ["off", 0]] as const) {
      const events: any[] = [];
      const ctx: any = {
        failurePropagation: mode,
        statelogClient: { warn: (e: any) => { events.push(e); } },
      };
      agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
        expect(() => checkResultMethodCall(f, "split")).not.toThrow();
      });
      expect(events).toHaveLength(expectedLogs);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/runtime/failurePropagation.test.ts 2>&1 | tee /tmp/fp-task2.log`
Expected: FAIL — module `./failurePropagation.js` does not exist.

- [ ] **Step 3: Extract the existing `truncate` helper to a leaf module**

`lib/runtime/ipc.ts:157` has a private `truncate(val, maxLen = 200)` (JSON-stringify + slice + ellipsis). Do NOT import it from `ipc.js`: `ipc.ts` value-imports the subprocess machinery (`child_process`, `hooks.ts`, which value-imports `AgencyFunction`), so `agencyFunction.ts → failurePropagation.ts → ipc.ts → hooks.ts → agencyFunction.ts` would be a runtime import cycle, and every compiled program would load the IPC graph just to format error previews.

Instead, create `lib/runtime/truncate.ts` with no imports:

```ts
/** JSON-stringify a value and cap its length for log/error previews.
 *  Leaf module on purpose: imported by both ipc.ts and
 *  failurePropagation.ts, which must not pull in each other's graphs. */
export function truncate(val: any, maxLen = 200): string {
  const s = typeof val === "string" ? val : JSON.stringify(val);
  if (s == null) {
    return "undefined";
  }
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}
```

Delete the private copy in `ipc.ts` and import it from `./truncate.js` there.

- [ ] **Step 4: Implement the module**

Create `lib/runtime/failurePropagation.ts`:

```ts
import { agencyStore } from "./asyncContext.js";
import {
  failure,
  isFailure,
  isSuccess,
  propagateFailure,
  success,
  type ResultFailure,
} from "./result.js";
import { truncate } from "./truncate.js";
import type { FuncParam } from "./agencyFunction.js";

/** Runtime mode for the failure-propagation feature. "on": skip/throw.
 *  "warn": warnings only, legacy behavior otherwise. "off": no checks. */
export type FailurePropagationMode = "off" | "warn" | "on";

/** Resolve the active mode. Two defaults exist ON PURPOSE and only the
 *  other one flips at Stage 2: real compiled programs read the mode off
 *  their ExecutionContext (whose constructor default is the staged
 *  rollout value — "warn" in Stage 1); the `?? "on"` here applies only
 *  OUTSIDE an execution frame, i.e. bare unit tests and direct runtime
 *  callers, which have no config to honor and no corpus at risk, so they
 *  always get the strict rule. Do not change this fallback when flipping
 *  the rollout default. */
export function getFailurePropagationMode(): FailurePropagationMode {
  return agencyStore.getStore()?.ctx?.failurePropagation ?? "on";
}

/** Symbol.for so the tag survives duplicated module instances (e.g. a
 *  test importing both src and dist copies of the runtime). */
const ACCEPTS_FAILURES = Symbol.for("agency.acceptsFailures");

/** Tag a plain TypeScript function as legitimately receiving failure
 *  values, exempting it from the dispatcher's failure-argument check. */
export function acceptsFailures<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ACCEPTS_FAILURES] = true;
  return fn;
}

export function isFailureTolerant(fn: unknown): boolean {
  if (typeof fn !== "function") {
    return false;
  }
  // An ALIASED JSON.stringify (`const s = JSON.stringify; s(f)`) routes
  // through __call; stringifying a failure is a legitimate debugging move,
  // and the function is native, so tag by identity. (Direct
  // `JSON.stringify(f)` goes through __callMethod, which does not scan
  // arguments at all — see the __call-only constraint.)
  if (fn === JSON.stringify) {
    return true;
  }
  return (fn as any)[ACCEPTS_FAILURES] === true;
}

// These four are DIRECT_CALL_FUNCTIONS (nameClassifier.ts), so by-name
// calls never reach the dispatcher. Tag them anyway: aliased and
// higher-order uses (`const f = isFailure; f(x)`, `const mk = failure;
// mk(inner)`) route through __call like any other value.
acceptsFailures(isSuccess);
acceptsFailures(isFailure);
acceptsFailures(success);
acceptsFailures(failure);

function origin(f: ResultFailure): string {
  return f.functionName ?? "(unknown)";
}

function logWarn(mode: FailurePropagationMode, message: string, detail: {
  functionName?: string;
  param?: string;
  error?: unknown;
}): void {
  const ctx = agencyStore.getStore()?.ctx;
  // Fire-and-forget, like handlerDecision in interrupts.ts. Optional-chained
  // end to end: unit tests and mock contexts may lack a statelog client.
  void ctx?.statelogClient?.warn?.({
    warnType: "failurePropagation",
    message,
    functionName: detail.functionName,
    param: detail.param,
    error: detail.error,
  });
  // Warn mode exists to be SEEN: without observability config the statelog
  // event goes nowhere, so echo to stderr. "on" mode stays quiet here — its
  // skip/throw is the signal. (statelogClient itself uses console.warn, so
  // this is an allowed pattern.)
  if (mode === "warn") {
    console.warn(`failurePropagation: ${message}`);
  }
}

/** The failure carried by this argument slot, if any. A variadic slot
 *  holds the gathered array, so scan its elements; any other array is
 *  opaque (shallow check — collecting Results into arrays is legitimate). */
function findFailureInArg(param: FuncParam, arg: unknown): ResultFailure | undefined {
  if (param.variadic && Array.isArray(arg)) {
    return arg.find(isFailure);
  }
  if (isFailure(arg)) {
    return arg;
  }
  return undefined;
}

/**
 * Scan resolved call arguments for failures landing on params that do not
 * accept Results. `args` is aligned index-for-index with `params` (invoke
 * passes the merged, resolved list; the variadic slot holds the gathered
 * array). Returns the failure to propagate, or null to proceed with the
 * call. Only `acceptsResult === false` rejects — absent means a legacy or
 * handcrafted param, which fails open.
 */
export function checkFailureArgs(
  fnName: string,
  params: FuncParam[],
  args: unknown[],
): ResultFailure | null {
  const mode = getFailurePropagationMode();
  if (mode === "off") {
    return null;
  }
  const count = Math.min(params.length, args.length);
  for (let i = 0; i < count; i++) {
    const param = params[i];
    if (param.acceptsResult !== false) {
      continue;
    }
    const hit = findFailureInArg(param, args[i]);
    if (hit === undefined) {
      continue;
    }
    logWarn(
      mode,
      `call to '${fnName}' skipped: parameter '${param.name}' received a failure produced by '${origin(hit)}' (${truncate(hit.error)})`,
      { functionName: fnName, param: param.name, error: hit.error },
    );
    if (mode === "warn") {
      // Census semantics: warn mode exists to MEASURE, so log every
      // rejecting hit in the call rather than stopping at the first.
      // "on" mode acts on the first (leftmost) hit only.
      continue;
    }
    return propagateFailure(hit, { name: fnName, param: param.name });
  }
  return null;
}

/**
 * A failure passed to a plain TypeScript function is always a mistake
 * unless the function is tagged. Throws a plain Error (NEVER AgencyAbort —
 * the enclosing auto-try must convert it into a catchable failure).
 */
export function checkTsFunctionArgs(
  target: Function,
  fnName: string,
  args: unknown[],
): void {
  const mode = getFailurePropagationMode();
  if (mode === "off" || isFailureTolerant(target)) {
    return;
  }
  for (const arg of args) {
    if (!isFailure(arg)) {
      continue;
    }
    const message =
      `'${fnName}' received a failure produced by '${origin(arg)}' (${truncate(arg.error)}). ` +
      `TypeScript functions cannot receive failures. Check the Result before passing it, ` +
      `or tag the function with acceptsFailures().`;
    logWarn(mode, message, { functionName: fnName, error: arg.error });
    if (mode === "on") {
      throw new Error(message);
    }
    // warn mode: census — keep scanning so every failure arg is logged.
  }
}

/**
 * A method call on a Result throws, unless the property is an own field
 * holding a callable (`r.value()` when the success wraps a function or
 * AgencyFunction). Prototype methods like .toString() throw too. Plain
 * Error only — see checkTsFunctionArgs.
 */
export function checkResultMethodCall(
  obj: unknown,
  prop: string | number,
): void {
  const isFailureObj = isFailure(obj);
  if (!isFailureObj && !isSuccess(obj)) {
    return;
  }
  const mode = getFailurePropagationMode();
  if (mode === "off") {
    return;
  }
  if (Object.hasOwn(obj as object, prop)) {
    const own = (obj as any)[prop];
    if (typeof own === "function" || (own as any)?.__agencyFunction === true) {
      return;
    }
  }
  const message = isFailureObj
    ? `called '.${String(prop)}()' on a failure produced by '${origin(obj as ResultFailure)}' (${truncate((obj as ResultFailure).error)}). Check the Result before using it.`
    : `called '.${String(prop)}()' on a success Result. Did you mean .value.${String(prop)}(...)?`;
  logWarn(mode, message, { param: String(prop) });
  if (mode === "on") {
    throw new Error(message);
  }
  // warn mode: the call falls through to today's generic "Cannot call
  // non-function value at property ..." error downstream. That IS the
  // legacy behavior warn mode promises — do not "fix" it.
}

/** Message for `__call` when the call TARGET itself is a failure value.
 *  Deliberately NOT mode-gated: this path already threw ("Cannot call
 *  non-function value") before this feature, so enriching the message is
 *  not a behavior change and warn mode's legacy-behavior promise holds. */
export function describeFailureCallTarget(f: ResultFailure): string {
  return (
    `Cannot call a failure value produced by '${origin(f)}' (${truncate(f.error)}). ` +
    `Check the Result before calling it.`
  );
}
```

- [ ] **Step 5: Add `StatelogClient.warn()`**

In `lib/statelogClient.ts`, directly after the `error()` method (~line 1147), add:

```ts
  /** Structured warning event. First consumer: the failure-propagation
   *  check (warnType "failurePropagation"), which logs every skipped call
   *  and every would-be throw in "warn" mode, and every skip in "on" mode. */
  async warn({
    warnType,
    message,
    functionName,
    param,
    error,
  }: {
    warnType: "failurePropagation";
    message: string;
    functionName?: string;
    param?: string;
    error?: unknown;
  }): Promise<void> {
    await this.post({
      type: "warn",
      warnType,
      message,
      functionName,
      param,
      error,
    });
  }
```

- [ ] **Step 6: Tag stdlib TS print helpers**

In `lib/stdlib/builtins.ts`: import the tag and apply it to `_print` (line ~18) and `_printJSON` (find it in the same file with `grep -n "_printJSON" lib/stdlib/builtins.ts`; if it lives in another `lib/stdlib/*.ts` file, tag it there):

```ts
import { acceptsFailures } from "../runtime/failurePropagation.js";
```

and after each function declaration:

```ts
acceptsFailures(_print);
acceptsFailures(_printJSON);
```

- [ ] **Step 7: Export the public tag**

In `lib/runtime/index.ts`, next to the existing `isFailure` export (~line 139), add:

```ts
export { acceptsFailures } from "./failurePropagation.js";
```

- [ ] **Step 8: Run tests**

Run: `pnpm test:run lib/runtime/failurePropagation.test.ts 2>&1 | tee /tmp/fp-task2.log`
Expected: PASS.

Run: `make 2>&1 | tee /tmp/fp-task2-build.log`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add -A lib
printf 'runtime: failure-propagation checks, acceptsFailures tag, statelog warn event\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 3: Wire the check into `AgencyFunction.invoke()`

**Files:**
- Modify: `lib/runtime/agencyFunction.ts` (type `FuncParam` ~line 10, constructor ~line 82, `invoke()` ~line 139)
- Test: `lib/runtime/failurePropagation.test.ts` (extend)

**Interfaces:**
- Consumes: `checkFailureArgs` from `./failurePropagation.js` (Task 2).
- Produces: `FuncParam.acceptsResult?: boolean` — Task 7's codegen emits this exact field name. Invoke-level behavior: a call whose rejecting param receives a failure returns the propagated `ResultFailure` instead of running the body.

- [ ] **Step 1: Write the failing tests**

Append to `lib/runtime/failurePropagation.test.ts`:

```ts
import { AgencyFunction } from "./agencyFunction.js";

function makeFn(
  params: Array<Partial<FuncParam> & { name: string }>,
  fn: (...args: any[]) => any,
) {
  return new AgencyFunction({
    name: "target",
    module: "test.agency",
    fn,
    params: params.map((p) => ({
      hasDefault: false,
      defaultValue: undefined,
      variadic: false,
      ...p,
    })),
    toolDefinition: null,
  });
}

describe("invoke() failure propagation", () => {
  const f = failure("boom", { functionName: "origin" });

  it("skips the body and propagates for a rejecting param", async () => {
    let ran = false;
    const fn = makeFn([{ name: "text", acceptsResult: false }], () => { ran = true; });
    const out: any = await fn.invoke({ type: "positional", args: [f] });
    expect(ran).toBe(false);
    expect(isFailure(out)).toBe(true);
    expect(out.error).toBe("boom");
    expect(out.skippedFunctions).toEqual([{ name: "target", param: "text" }]);
  });

  it("runs the body for accepting and legacy params", async () => {
    const accepting = makeFn([{ name: "r", acceptsResult: true }], (r: unknown) => r);
    expect(isFailure(await accepting.invoke({ type: "positional", args: [f] }))).toBe(true);
    const legacy = makeFn([{ name: "r" }], (r: unknown) => "ran");
    expect(await legacy.invoke({ type: "positional", args: [f] })).toBe("ran");
  });

  it("checks values bound via .partial()", async () => {
    let ran = false;
    const fn = makeFn(
      [{ name: "a", acceptsResult: false }, { name: "b", acceptsResult: false }],
      () => { ran = true; },
    );
    const bound = fn.partial({ a: f });
    const out: any = await bound.invoke({ type: "positional", args: ["ok"] });
    expect(ran).toBe(false);
    expect(out.skippedFunctions).toEqual([{ name: "target", param: "a" }]);
  });

  it("checks named arguments", async () => {
    const fn = makeFn([{ name: "x", acceptsResult: false }], () => "ran");
    const out: any = await fn.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { x: f },
    });
    expect(out.skippedFunctions).toEqual([{ name: "target", param: "x" }]);
  });

  it("UNSET padding on an omitted defaulted param is skipped; a failure on a later param still trips", async () => {
    const fn = makeFn(
      [
        { name: "a", hasDefault: true, acceptsResult: false },
        { name: "b", acceptsResult: false },
      ],
      () => "ran",
    );
    const out: any = await fn.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { b: f },
    });
    expect(out.skippedFunctions).toEqual([{ name: "target", param: "b" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm test:run lib/runtime/failurePropagation.test.ts 2>&1 | tee /tmp/fp-task3.log`
Expected: the five new tests FAIL (body runs, no propagation); earlier tests still pass.

- [ ] **Step 3: Implement**

In `lib/runtime/agencyFunction.ts`:

Add to `FuncParam` (after `isFunctionTyped`):

```ts
  /**
   * False when the parameter's declared type does NOT accept Result values —
   * i.e. it is not `Result`/`Result<...>`, not explicit `any`, and not a
   * union containing either. Set by codegen from the static
   * `paramAcceptsFailure` predicate (lib/typeChecker/utils.ts); consumed by
   * the failure-propagation check in invoke().
   *
   * Absent on legacy/handcrafted FuncParam values, and absence fails OPEN
   * (the param accepts failures) — same convention as `isFunctionTyped`.
   */
  acceptsResult?: boolean;
```

Add import:

```ts
import { checkFailureArgs } from "./failurePropagation.js";
```

Add a private field and constructor line (next to `_isBound`):

```ts
  private readonly _checksFailures: boolean;
```

```ts
    this._checksFailures = opts.params.some(p => p.acceptsResult === false);
```

In `invoke()`, replace the body of the `withCallDepth` callback:

```ts
    return withCallDepth(this.name, () => {
      const args = this._isBound
        ? this.mergeWithBound(this.resolveArgs(descriptor))
        : this.resolveArgs(descriptor);
      // Failure propagation: a failure landing on a param that does not
      // accept Results skips the body and returns the original failure
      // (spec: docs/superpowers/specs/2026-07-08-failure-propagation-design.md).
      // `args` is aligned with `this.params` in both branches: mergeWithBound
      // rebuilds the full list, and in the unbound case params ARE the
      // unbound list (variadic slot = gathered array). Skipping the body
      // also skips its pushHandler calls — safe for the same reason pipe
      // short-circuiting is safe: the call never begins, so no partial run
      // can raise an effect past an unregistered handler.
      if (this._checksFailures) {
        const propagated = checkFailureArgs(this.name, this.params, args);
        if (propagated !== null) return propagated;
      }
      return this._fn(...args);
    });
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/runtime/failurePropagation.test.ts lib/runtime/agencyFunction.test.ts lib/runtime/call.test.ts 2>&1 | tee /tmp/fp-task3.log`
Expected: PASS (existing agencyFunction/call tests construct params without `acceptsResult`, which fails open).

- [ ] **Step 5: Commit**

```bash
git add -A lib
printf 'runtime: failure-propagation check at the invoke() chokepoint\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 4: Dispatcher checks in `__call` / `__callMethod`

**Files:**
- Modify: `lib/runtime/call.ts`
- Test: `lib/runtime/failurePropagation.test.ts` (extend)

**Interfaces:**
- Consumes: `checkTsFunctionArgs`, `checkResultMethodCall`, `describeFailureCallTarget` from `./failurePropagation.js`; `isFailure` from `./result.js`.
- Produces: dispatcher behavior only (no new exports).

- [ ] **Step 1: Write the failing tests**

Append to `lib/runtime/failurePropagation.test.ts`:

```ts
import { __call, __callMethod } from "./call.js";

describe("dispatcher failure checks", () => {
  const f = failure("boom", { functionName: "origin" });

  it("__call: failure arg into an untagged plain TS function throws", async () => {
    const target = function formatDate() {};
    await expect(
      __call(target, { type: "positional", args: [f] }),
    ).rejects.toThrowError(/formatDate.*origin/s);
  });

  it("__call: tagged plain TS function receives the failure", async () => {
    const seen: unknown[] = [];
    const target = acceptsFailures((...args: unknown[]) => { seen.push(...args); });
    await __call(target, { type: "positional", args: [f] });
    expect(isFailure(seen[0])).toBe(true);
  });

  it("__call: calling a failure value gives the rich message", async () => {
    await expect(
      __call(f, { type: "positional", args: [] }),
    ).rejects.toThrowError(/failure value produced by 'origin'/);
  });

  it("__callMethod: method call on a failure throws the rich message", async () => {
    await expect(
      __callMethod(f, "split", { type: "positional", args: [" "] }),
    ).rejects.toThrowError(/split.*origin/s);
  });

  it("__callMethod: method call on a success throws with the .value hint", async () => {
    await expect(
      __callMethod(success(5), "toFixed", { type: "positional", args: [1] }),
    ).rejects.toThrowError(/\.value\./);
  });

  it("__callMethod: r.value() works when the success wraps a function", async () => {
    const s = success((n: number) => n + 1);
    const out = await __callMethod(s, "value", { type: "positional", args: [41] });
    expect(out).toBe(42);
  });

  it("__callMethod: method arguments are NOT scanned — arr.push(failure) works", async () => {
    // CRITICAL contract (plan-review finding 1): native prototype methods
    // are untagged plain functions, and collecting Results into arrays is
    // the pattern the shallow check exists to protect. The TS-function
    // argument scan therefore lives in __call ONLY.
    const arr: unknown[] = [];
    await __callMethod(arr, "push", { type: "positional", args: [f] });
    expect(arr).toHaveLength(1);
    const out = await __callMethod(arr, "includes", { type: "positional", args: [f] });
    expect(out).toBe(true);
  });

  it("__call: an ALIASED JSON.stringify accepts a failure by identity", async () => {
    const stringify = JSON.stringify;
    const out = await __call(stringify, { type: "positional", args: [f] });
    expect(typeof out).toBe("string");
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm test:run lib/runtime/failurePropagation.test.ts 2>&1 | tee /tmp/fp-task4.log`
Expected: the new `dispatcher failure checks` tests FAIL.

- [ ] **Step 3: Implement**

In `lib/runtime/call.ts`:

Add imports:

```ts
import {
  checkTsFunctionArgs,
  checkResultMethodCall,
  describeFailureCallTarget,
} from "./failurePropagation.js";
import { isFailure } from "./result.js";
```

In `__call`, replace the non-function guard (currently `throw new Error(\`Cannot call non-function value: ...\`)`):

```ts
  if (typeof target !== "function") {
    if (isFailure(target)) {
      throw new Error(describeFailureCallTarget(target));
    }
    throw new Error(`Cannot call non-function value: ${String(target)}`);
  }
```

In `__call`, immediately before the final `return target(...descriptor.args);`:

```ts
  checkTsFunctionArgs(target, target.name || "(anonymous)", descriptor.args);
```

In `__callMethod`, after the AgencyFunction `.partial`/`.describe`/`.rename`/`.preapprove` branch and BEFORE `const target = (obj as any)[prop];`:

```ts
  // A method call on a Result object is a forgotten-unwrap bug unless the
  // property is an own field holding a callable (`r.value()` on a
  // function-wrapping success). Throws a plain Error; the enclosing
  // auto-try converts it into a catchable failure.
  //
  // Deliberately the ONLY check in __callMethod: method ARGUMENTS are not
  // scanned, because native prototype methods are untagged plain functions
  // and `arr.push(someFailure)` / `arr.includes(f)` must keep working
  // (collecting Results into arrays is the pattern the shallow check
  // protects). The TS-function argument scan lives in __call only.
  checkResultMethodCall(obj, prop);
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/runtime/failurePropagation.test.ts lib/runtime/call.test.ts 2>&1 | tee /tmp/fp-task4.log`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A lib
printf 'runtime: dispatcher checks for failures into TS functions and Result method calls\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 5: Teach the typechecker the `skippedFunctions` field

**Files:**
- Modify: `lib/typeChecker/resultUnion.ts` (failure branch object, ~line 36)
- Modify: `lib/typeChecker/synthesizer.ts` (`RESULT_FIELDS`, ~line 43)
- Test: extend the narrowing/member-access test file that covers `r.error` on a narrowed failure — find it with `grep -rn "retryable" lib/typeChecker/*.test.ts lib/typeChecker/**/*.test.ts | head`, and add the new case beside the existing failure-field tests.

**Interfaces:**
- Consumes: field name `skippedFunctions` with element shape `{ name: string; param: string }` (Task 1).
- Produces: Agency programs can read `f.skippedFunctions` on a narrowed failure without a `strictMemberAccess` error — Task 9's execution tests rely on this.

- [ ] **Step 1: Write the failing test**

In the test file located above, add next to the existing failure-member tests (adjust the helper names to match that file's local conventions — it will have an existing "narrowed failure allows .error / .retryable" style test to copy):

```ts
it("allows skippedFunctions on a narrowed failure", () => {
  const errors = typecheckSnippet(`
    def f(): Result { return failure("x") }
    def g(): string {
      const r = f()
      if (isFailure(r)) {
        const skips = r.skippedFunctions
        return "count ${skips.length}"
      }
      return "ok"
    }
  `);
  expect(errors.filter((e) => (e.severity ?? "error") === "error")).toEqual([]);
});

it("negative control: a misspelled failure member still errors (proves enforcement is armed)", () => {
  const errors = typecheckSnippet(`
    def f(): Result { return failure("x") }
    def g(): string {
      const r = f()
      if (isFailure(r)) {
        const skips = r.skippedFunctionz
        return "count ${skips.length}"
      }
      return "ok"
    }
  `);
  expect(
    errors.filter((e) => (e.severity ?? "error") === "error").length,
  ).toBeGreaterThan(0);
});
```

(Use the file's existing snippet-checking helper; the assertion pattern `(e.severity ?? "error")` matters — type-mismatch diagnostics can carry `undefined` severity.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:run <that test file> 2>&1 | tee /tmp/fp-task5.log`
Expected: FAIL — `skippedFunctions` does not exist on the failure branch.

- [ ] **Step 3: Implement**

In `lib/typeChecker/resultUnion.ts`, add to the failure-branch `properties` array (after the `args` entry):

```ts
          // Propagation trail appended by the failure-propagation runtime
          // check (lib/runtime/failurePropagation.ts). Mirrors
          // SkippedFunction in lib/runtime/result.ts.
          {
            key: "skippedFunctions",
            value: {
              type: "arrayType",
              elementType: {
                type: "objectType",
                properties: [
                  { key: "name", value: STRING_T },
                  { key: "param", value: STRING_T },
                ],
              },
            },
          },
```

In `lib/typeChecker/synthesizer.ts`, add to `RESULT_FIELDS`:

```ts
  "skippedFunctions",
```

- [ ] **Step 4: Run the typechecker test suite**

Run: `pnpm test:run lib/typeChecker 2>&1 | tee /tmp/fp-task5.log`
Expected: PASS, including the new test.

- [ ] **Step 5: Commit**

```bash
git add -A lib
printf 'typechecker: skippedFunctions member on the failure branch\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 6: `failurePropagation` config knob

**Files:**
- Modify: `lib/config.ts` (option type after `maxCallDepth` ~line 226; zod schema ~line 443)
- Modify: `lib/runtime/state/context.ts` (mirror the four `maxCallDepth` sites: field ~line 175, args type ~line 203, constructor default ~line 229, execCtx copy ~line 318)
- Modify: `lib/backends/typescriptBuilder.ts` (runtimeCtxArgs, next to `maxCallDepth` ~line 3975)
- Modify: `lib/runtime/configOverrides.ts` (mirror every `maxCallDepth` occurrence — type field ~line 16, merge ~line 93, and the parent-side collection site; find all with `grep -n maxCallDepth lib/runtime/configOverrides.ts`)
- Test: `lib/runtime/configOverrides.test.ts` (extend, following its existing `maxCallDepth` test)

**Interfaces:**
- Consumes: `FailurePropagationMode` shape `"off" | "warn" | "on"` (Task 2 reads `ctx.failurePropagation`).
- Produces: `AgencyConfig.failurePropagation?: "off" | "warn" | "on"`; `ExecutionContext.failurePropagation` defaulting `"warn"` (Stage 1); subprocess inheritance.

- [ ] **Step 1: Write the failing test**

In `lib/runtime/configOverrides.test.ts`, copy the existing `maxCallDepth` inheritance test and adapt:

```ts
it("inherits failurePropagation from overrides", () => {
  const merged = applyConfigOverrides(baseArgs, { failurePropagation: "warn" });
  expect(merged.failurePropagation).toBe("warn");
});
```

(Match the file's actual helper/fixture names — mirror whatever the `maxCallDepth` test does, exactly.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/configOverrides.test.ts 2>&1 | tee /tmp/fp-task6.log`
Expected: FAIL — field does not exist / is not merged.

- [ ] **Step 3: Implement all five plumbing sites**

`lib/config.ts`, after `maxCallDepth`:

```ts
  /** Failure-propagation mode. "warn" (current default, flips to "on" in a
   * follow-up release): warnings only, legacy behavior otherwise. "on": a
   * failure value passed to a parameter not typed to accept Results skips
   * the call and propagates the original failure; failures into plain TS
   * functions and method calls on Results throw. "off": no checks. */
  failurePropagation?: "off" | "warn" | "on";
```

`lib/config.ts` zod schema, after the `maxCallDepth` entry:

```ts
    failurePropagation: z.enum(["off", "warn", "on"]),
```

`lib/runtime/state/context.ts` — mirror `maxCallDepth` at all four sites:

```ts
  failurePropagation: "off" | "warn" | "on";            // field (~175)
    failurePropagation?: "off" | "warn" | "on";         // constructor args (~203)
    // Stage 1 rollout default: every real compiled program warns without
    // changing behavior. Stage 2 flips this one literal to "on" after the
    // corpus measurement (do NOT touch the frameless "on" fallback in
    // failurePropagation.ts, which serves unit tests).
    this.failurePropagation = args.failurePropagation ?? "warn"; // (~229)
    execCtx.failurePropagation = this.failurePropagation;        // (~318)
```

`lib/backends/typescriptBuilder.ts`, next to the `maxCallDepth` runtimeCtxArgs block:

```ts
    if (this.agencyConfig.failurePropagation !== undefined) {
      runtimeCtxArgs.failurePropagation = ts.str(
        this.agencyConfig.failurePropagation,
      );
    }
```

`lib/runtime/configOverrides.ts` — mirror every `maxCallDepth` occurrence (type field, parent-side collection, merge):

```ts
  failurePropagation?: "off" | "warn" | "on";
```

```ts
  if (overrides.failurePropagation !== undefined) {
    merged.failurePropagation = overrides.failurePropagation;
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/runtime/configOverrides.test.ts lib/config.test.ts 2>&1 | tee /tmp/fp-task6.log` (drop `lib/config.test.ts` if it does not exist)
Expected: PASS. Then `make 2>&1 | tee /tmp/fp-task6-build.log` — clean.

- [ ] **Step 5: End-to-end coverage for "off" and "warn" (agency-js tests)**

The mode default masks any break in plumbing the other values (a `runtimeCtxArgs` typo, a missed `execCtx` copy), so cover all three values config → codegen → context → mode-read end to end. The `"on"` directory doubles as Stage 1's end-to-end proof of the strict behavior, before the Stage 2 default flip. Agency-js test contract (mirror `tests/agency-js/tag-fork-redaction/`): a directory with `agency.json` (compiler config), `agent.agency`, `test.js` (writes `__result.json`), and `fixture.json` (the expected `__result.json` content).

`tests/agency-js/failure-propagation-off/agency.json`:

```json
{
  "failurePropagation": "off"
}
```

`tests/agency-js/failure-propagation-off/agent.agency`:

```agency
def bad(): Result {
  return failure("boom")
}

def use(s: string) {
  return "ran"
}

node main() {
  const f = bad()
  const out = use(f)
  if (isFailure(out)) {
    return "skipped"
  }
  return "legacy: ${out}"
}
```

`tests/agency-js/failure-propagation-off/test.js`:

```js
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ legacyBehavior: result === "legacy: ran" }, null, 2),
);
```

`tests/agency-js/failure-propagation-off/fixture.json`:

```json
{
  "legacyBehavior": true
}
```

`tests/agency-js/failure-propagation-warn/agency.json`:

```json
{
  "failurePropagation": "warn",
  "observability": true,
  "log": {
    "logFile": "statelog.log"
  }
}
```

`tests/agency-js/failure-propagation-warn/agent.agency`: identical to the off test's program.

`tests/agency-js/failure-propagation-warn/test.js`:

```js
import { main } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// Warn mode must (a) leave behavior untouched and (b) emit the
// failurePropagation warn event to statelog. This is the end-to-end
// version of the spec's "statelog assertion for the skip event".

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const result = await main();
const log = readFileSync("statelog.log", "utf-8");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      legacyBehavior: result === "legacy: ran",
      warnEventLogged:
        log.includes('"type":"warn"') && log.includes("failurePropagation"),
    },
    null,
    2,
  ),
);
```

`tests/agency-js/failure-propagation-warn/fixture.json`:

```json
{
  "legacyBehavior": true,
  "warnEventLogged": true
}
```

`tests/agency-js/failure-propagation-on/agency.json`:

```json
{
  "failurePropagation": "on"
}
```

`tests/agency-js/failure-propagation-on/agent.agency`: identical to the off test's program.

`tests/agency-js/failure-propagation-on/test.js`:

```js
import { main } from "./agent.js";
import { writeFileSync } from "fs";

// Opting a compiled program into "on" exercises the strict behavior end to
// end during Stage 1, while the shipped default is still "warn". This is
// the guard that makes the Stage 2 default flip a no-surprise diff.

const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify({ skipped: result === "skipped" }, null, 2),
);
```

`tests/agency-js/failure-propagation-on/fixture.json`:

```json
{
  "skipped": true
}
```

Run all three (save output):

```bash
pnpm run agency test js tests/agency-js/failure-propagation-off 2>&1 | tee /tmp/fp-task6-off.log
pnpm run agency test js tests/agency-js/failure-propagation-warn 2>&1 | tee /tmp/fp-task6-warn.log
pnpm run agency test js tests/agency-js/failure-propagation-on 2>&1 | tee /tmp/fp-task6-on.log
```

Expected: all PASS. (If the runner wants the `agent.agency` path rather than the directory, invoke it however CI invokes the neighboring agency-js tests.)

- [ ] **Step 6: Commit**

```bash
git add -A lib tests
printf 'config: failurePropagation knob (off/warn/on, staged default warn), plumbed like maxCallDepth\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 7: Codegen — `paramAcceptsFailure` predicate and `acceptsResult` emission

**Files:**
- Modify: `lib/typeChecker/utils.ts` (add predicate next to `isFunctionTyped`, ~line 69)
- Modify: `lib/backends/typescriptBuilder.ts` (param metadata emission ~line 2161-2168; import at ~line 99)
- Create: `lib/typeChecker/paramAcceptsFailure.test.ts`
- Regenerate: `tests/typescriptGenerator/` fixtures via `make fixtures`

**Interfaces:**
- Consumes: `FunctionParameter` (has `typeHint?: VariableType`, `variadic?: boolean`); `VariableType` variants `resultType`, `primitiveType`, `unionType`, `arrayType` from `lib/types/typeHints.ts`.
- Produces: `paramAcceptsFailure(param: FunctionParameter): boolean` exported from `lib/typeChecker/utils.ts`; generated `AgencyFunction.create` params gain `acceptsResult: <bool>` (consumed by Task 3's runtime).

- [ ] **Step 1: Write the failing tests**

Create `lib/typeChecker/paramAcceptsFailure.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { paramAcceptsFailure } from "./utils.js";
import type { FunctionParameter } from "../types/function.js";

const ANY = { type: "primitiveType", value: "any" } as const;
const STR = { type: "primitiveType", value: "string" } as const;
const RESULT = { type: "resultType", successType: ANY, failureType: ANY } as const;

function makeParam(overrides: Record<string, unknown>): FunctionParameter {
  return { name: "x", ...overrides } as unknown as FunctionParameter;
}

describe("paramAcceptsFailure", () => {
  it("unannotated rejects", () => {
    expect(paramAcceptsFailure(makeParam({}))).toBe(false);
  });
  it("concrete types reject", () => {
    expect(paramAcceptsFailure(makeParam({ typeHint: STR }))).toBe(false);
  });
  it("explicit any accepts", () => {
    expect(paramAcceptsFailure(makeParam({ typeHint: ANY }))).toBe(true);
  });
  it("Result and Result<...> accept", () => {
    expect(paramAcceptsFailure(makeParam({ typeHint: RESULT }))).toBe(true);
    expect(
      paramAcceptsFailure(makeParam({ typeHint: { type: "resultType", successType: STR, failureType: STR } })),
    ).toBe(true);
  });
  it("unions accept iff an arm accepts", () => {
    expect(paramAcceptsFailure(makeParam({ typeHint: { type: "unionType", types: [STR, RESULT] } }))).toBe(true);
    expect(paramAcceptsFailure(makeParam({ typeHint: { type: "unionType", types: [STR, STR] } }))).toBe(false);
  });
  it("variadic checks the element type", () => {
    expect(
      paramAcceptsFailure(makeParam({ variadic: true, typeHint: { type: "arrayType", elementType: ANY } })),
    ).toBe(true);
    expect(
      paramAcceptsFailure(makeParam({ variadic: true, typeHint: { type: "arrayType", elementType: STR } })),
    ).toBe(false);
    expect(paramAcceptsFailure(makeParam({ variadic: true }))).toBe(false);
  });
  it("alias-wrapped Result rejects (v1 limitation, no alias resolution)", () => {
    expect(
      paramAcceptsFailure(makeParam({ typeHint: { type: "typeAliasVariable", aliasName: "MyR" } })),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/typeChecker/paramAcceptsFailure.test.ts 2>&1 | tee /tmp/fp-task7.log`
Expected: FAIL — `paramAcceptsFailure` is not exported.

- [ ] **Step 3: Implement the predicate**

In `lib/typeChecker/utils.ts`, below `isFunctionTyped`:

```ts
/**
 * Static half of the failure-propagation rule (spec:
 * docs/superpowers/specs/2026-07-08-failure-propagation-design.md).
 * Returns true when the parameter's declared type accepts Result values:
 * `Result`/`Result<...>`, explicit `any`, or a union containing either.
 *
 * Unannotated params return false — the strict rule. For a variadic
 * `...xs: T[]` the ELEMENT type decides, matching how the runtime checks
 * each gathered element. `typeAliasVariable` returns false (v1: aliases
 * are not resolved here; an alias of Result trips the runtime check and
 * the error message teaches the inline annotation).
 *
 * Emitted into FuncParam.acceptsResult by the typescript builder; consumed
 * by checkFailureArgs (lib/runtime/failurePropagation.ts).
 */
export function paramAcceptsFailure(param: FunctionParameter): boolean {
  const hint = param.typeHint;
  if (!hint) return false;
  if (param.variadic) {
    if (hint.type !== "arrayType") return false;
    return typeAcceptsResult(hint.elementType);
  }
  return typeAcceptsResult(hint);
}

function typeAcceptsResult(t: VariableType): boolean {
  if (t.type === "resultType") return true;
  if (t.type === "primitiveType" && t.value === "any") return true;
  if (t.type === "unionType") return t.types.some(typeAcceptsResult);
  return false;
}
```

(`isAnyType` already exists in this file; `typeAcceptsResult` inlines the same check to keep the union recursion in one place.)

- [ ] **Step 4: Emit the flag in codegen**

In `lib/backends/typescriptBuilder.ts`:

Extend the line-99 import:

```ts
import { isFunctionTyped, paramAcceptsFailure } from "../typeChecker/utils.js";
```

In the `paramNodes` map (~line 2161), after the `isFunctionTyped` line:

```ts
        acceptsResult: ts.bool(paramAcceptsFailure(p)),
```

- [ ] **Step 5: Run predicate tests, then rebuild fixtures**

Run: `pnpm test:run lib/typeChecker/paramAcceptsFailure.test.ts 2>&1 | tee /tmp/fp-task7.log`
Expected: PASS.

Run: `make fixtures 2>&1 | tee /tmp/fp-task7-fixtures.log`
Then: `git diff --stat tests/typescriptGenerator | tail -5`
Expected: many fixture files change, each adding `acceptsResult: true|false` lines in params metadata. Spot-check one fixture with a typed param (expect `acceptsResult: false`) and one with an `any`/Result param (expect `true`). No other diff shape is acceptable — investigate anything else.

- [ ] **Step 6: Run the full unit suite**

Run: `pnpm test:run 2>&1 | tee /tmp/fp-task7-all.log`
Expected: PASS. Task 6 landed the `ExecutionContext` `"warn"` default BEFORE this task on purpose (task order matters: with the flags emitted but no context field, the frameless `?? "on"` fallback would enforce strict mode across the whole suite). Compiled programs therefore run under `"warn"` here, so codegen emitting the flags must NOT change any test outcome — a behavioral failure means an alignment/logic bug in the check itself, not a "legitimate site". Watch the output for `failurePropagation:` console warnings; note any that appear, they preview what Stage 2's corpus run will surface.

- [ ] **Step 7: Commit**

```bash
git add -A lib tests
printf 'codegen: emit acceptsResult param flag from paramAcceptsFailure predicate\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 8: Stdlib annotation pass

**Files:**
- Modify: `stdlib/index.agency` (`def print(...messages)` ~line 46)

**Interfaces:**
- Consumes: variadic annotation syntax `...name: any[]` (same shape as `stdlib/path.agency`'s `...parts: string[]`).
- Produces: `print(someFailure)` keeps printing under the strict rule.

- [ ] **Step 1: Annotate print**

In `stdlib/index.agency` change:

```agency
export safe def print(...messages) {
```

to:

```agency
export safe def print(...messages: any[]) {
```

(`printJSON` already declares `obj: any` — no change. Do not annotate anything else yet; Stage 2's corpus run decides what else needs it. Under Stage 1's `"warn"` default this annotation only silences would-be warnings; its behavioral test — print must not be skipped — lands with the Stage 2 flip.)

- [ ] **Step 2: Rebuild**

Run: `make 2>&1 | tee /tmp/fp-task8-build.log`
Expected: clean (stdlib `.js` regenerates next to source).

- [ ] **Step 3: Regenerate the stdlib reference docs**

Changing `print`'s signature alters the generated `docs/site/stdlib/` page for `std::index`, and stdlib docs are generated, never hand-edited:

```bash
make doc 2>&1 | tee /tmp/fp-task8-doc.log
git diff --stat docs/site/stdlib | tail -3
```

Expected: only the `print` signature drift. Commit it with this task.

- [ ] **Step 4: Commit**

```bash
git add -A stdlib docs/site/stdlib
printf 'stdlib: annotate print variadic as any[] so failures remain printable\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 9: Stage 1 wrap-up — lint, unit suite, PR #1

**Files:** none new.

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: merged PR #1 (mechanism live, default `"warn"`).

- [ ] **Step 1: Lint and full unit suite**

```bash
pnpm run lint:structure 2>&1 | tee /tmp/fp-task9-lint.log
pnpm test:run 2>&1 | tee /tmp/fp-task9-unit.log
```

Expected: both clean. Fix anything they flag.

- [ ] **Step 2: Push and open PR #1**

Write the PR body to a file (apostrophe rule), then push the branch and open the PR with `gh`. The body must state: mechanism only, shipped default is `"warn"` (zero behavior change), strict behavior covered by unit tests and the `failure-propagation-on` agency-js test, default flips to `"on"` in the follow-up PR. CI should be green by construction — any execution-test failure here means the warn path itself is broken (a real bug, not a "legitimate site"), with one exception: the warn-mode `console.warn` echo adds stderr lines wherever the corpus already passes failures around, so if a PTY/full-terminal-output assertion fails, suspect stderr capture before suspecting the mechanism.

Stage 1 ends here. Do not start Task 10 until PR #1 is merged.

---

## Stage 2: flip the default to "on"

Start in a fresh worktree branched off updated main (e.g. `git worktree add .claude/worktrees/failure-propagation-flip -b failure-propagation-flip` from the repo root). Everything below assumes Stage 1 is merged.

### Task 10: Flip the ExecutionContext default

**Files:**
- Modify: `lib/runtime/state/context.ts` (the constructor default from Task 6)
- Modify: `lib/config.ts` (the option docstring from Task 6)

**Interfaces:**
- Consumes: the Stage 1 mechanism.
- Produces: strict behavior by default for every compiled program. Tasks 11–12 depend on this.

- [ ] **Step 1: Flip the one literal**

In `lib/runtime/state/context.ts`, change the constructor default:

```ts
    this.failurePropagation = args.failurePropagation ?? "on";
```

Do NOT touch the `?? "on"` fallback in `lib/runtime/failurePropagation.ts` (it already reads `"on"` and serves frameless unit tests). Update the comment above the constructor line to say the flip happened, and update the `failurePropagation` option docstring in `lib/config.ts` to say `"on"` is the default (it currently documents the Stage 1 `"warn"` default to users).

- [ ] **Step 2: Run the unit suite and the mode agency-js tests**

```bash
make 2>&1 | tee /tmp/fp-task10-build.log
pnpm test:run 2>&1 | tee /tmp/fp-task10-unit.log
for t in failure-propagation-off failure-propagation-warn failure-propagation-on; do
  pnpm run agency test js tests/agency-js/$t 2>&1 | tee /tmp/fp-task10-$t.log
done
```

Expected: all pass — the three agency-js tests set their mode explicitly, so the default flip must not change their outcomes.

- [ ] **Step 3: Commit**

```bash
git add -A lib
printf 'runtime: flip failurePropagation default to on\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 11: Agency execution tests (strict default)

**Files:**
- Create: `tests/agency/result/failure-propagation-basic.agency` + `.test.json`
- Create: `tests/agency/result/failure-propagation-modes.agency` + `.test.json`
- Create: `tests/agency/result/failure-propagation-compose.agency` + `.test.json`
- Create: `tests/agency/result/failure-method-call.agency` + `.test.json`
- Create: `tests/agency/result/failure-ts-function.agency` + `.test.json`
- Create: `tests/agency/result/failure-array-collect.agency` + `.test.json`
- Create: `tests/agency/result/failure-block-failopen.agency` + `.test.json`
- Create: `tests/agency/result/failure-async-propagation.agency` + `.test.json`
- Create: `tests/agency/result/failure-propagation-print.agency` + `.test.json` (moved from Task 8: only meaningful under the strict default)
- Create: `tests/agency/result/failure-helpers.js`

**Interfaces:**
- Consumes: everything shipped in Stage 1, plus Task 10's default flip, through real compiled programs.
- Produces: regression coverage; no exports.

Notes for all files: untyped return types on helper defs keep the typechecker relaxed about `isFailure(x)` on returned values. Every `.test.json` uses `"type": "exact"` — build the expected string deterministically in the program (`JSON.stringify` is identity-safelisted, so it may receive failures and skip-trails).

- [ ] **Step 1: Basic propagation + trail**

`tests/agency/result/failure-propagation-basic.agency`:

```agency
def getReport(id: string): Result {
  return failure("HTTP 404: report not found")
}

def wordCount(text: string) {
  return 999
}

def formatSummary(report: string) {
  return "summary"
}

node main() {
  const report = getReport("abc")
  const count = wordCount(report)
  const summary = formatSummary(count)
  if (isFailure(summary)) {
    const trail = JSON.stringify(summary.skippedFunctions)
    return "propagated ${summary.error} via ${trail}"
  }
  return "no propagation"
}
```

`tests/agency/result/failure-propagation-basic.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "propagated HTTP 404: report not found via [{\"name\":\"wordCount\",\"param\":\"text\"},{\"name\":\"formatSummary\",\"param\":\"report\"}]",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "a failure skips two typed/untyped params in a row and carries the two-hop trail"
    }
  ]
}
```

- [ ] **Step 2: Accepting params, leftmost-wins, variadic, partial**

`tests/agency/result/failure-propagation-modes.agency`:

```agency
def handle(r: Result) {
  if (isFailure(r)) {
    return "handled ${r.error}"
  }
  return "not failure"
}

def anything(x: any) {
  if (isFailure(x)) {
    return "any got failure"
  }
  return "any got value"
}

def pick(a: string, b: string) {
  return "ran pick"
}

def gather(...items) {
  return "ran gather"
}

node main() {
  const f1 = failure("first")
  const f2 = failure("second")

  const viaResult = handle(f1)
  const viaAny = anything(f1)

  let leftmost = "?"
  const picked = pick(f1, f2)
  if (isFailure(picked)) {
    leftmost = "${picked.error}:${JSON.stringify(picked.skippedFunctions)}"
  }

  let variadic = "?"
  const gathered = gather("ok", f1)
  if (isFailure(gathered)) {
    variadic = JSON.stringify(gathered.skippedFunctions)
  }

  let bound = "?"
  const pickA = pick.partial(a: f1)
  const boundOut = pickA("fine")
  if (isFailure(boundOut)) {
    bound = JSON.stringify(boundOut.skippedFunctions)
  }

  return "${viaResult} | ${viaAny} | ${leftmost} | ${variadic} | ${bound}"
}
```

`tests/agency/result/failure-propagation-modes.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "handled first | any got failure | first:[{\"name\":\"pick\",\"param\":\"a\"}] | [{\"name\":\"gather\",\"param\":\"items\"}] | [{\"name\":\"pick\",\"param\":\"a\"}]",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "Result/any params accept; leftmost failure wins; variadic elements and .partial()-bound values are checked"
    }
  ]
}
```

- [ ] **Step 3: Composition with catch and try**

`tests/agency/result/failure-propagation-compose.agency`:

```agency
def bad(): Result {
  return failure("boom")
}

def use(s: string) {
  return "used ${s}"
}

node main() {
  const f = bad()
  const withCatch = use(f) catch "fallback"
  const withTry = try use(f)
  let tryMsg = "try not failure"
  if (isFailure(withTry)) {
    tryMsg = "try failure ${withTry.error}"
  }
  return "${withCatch} | ${tryMsg}"
}
```

`tests/agency/result/failure-propagation-compose.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "fallback | try failure boom",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "catch unwraps a propagated failure into the fallback; try passes it through unchanged"
    }
  ]
}
```

- [ ] **Step 4: Method calls on Results**

`tests/agency/result/failure-method-call.agency`:

```agency
def getF(): Result {
  return failure("nope")
}

def callSplitOn(v: any) {
  const parts = v.split(" ")
  return "no throw"
}

def callToFixedOn(v: any) {
  const s = v.toFixed(1)
  return "no throw"
}

def addOne(n: number) {
  return n + 1
}

node main() {
  const f = getF()

  let failureMsg = "?"
  const r1 = try callSplitOn(f)
  if (isFailure(r1)) {
    let hasSplit = "no"
    if (r1.error.includes("split")) {
      hasSplit = "yes"
    }
    let hasOrigin = "no"
    if (r1.error.includes("getF")) {
      hasOrigin = "yes"
    }
    failureMsg = "split=${hasSplit} origin=${hasOrigin}"
  }

  let successMsg = "?"
  const s = success(5)
  const r2 = try callToFixedOn(s)
  if (isFailure(r2)) {
    let hasHint = "no"
    if (r2.error.includes(".value.")) {
      hasHint = "yes"
    }
    successMsg = "hint=${hasHint}"
  }

  const wrapped = success(addOne)
  const called = wrapped.value(41)

  return "${failureMsg} | ${successMsg} | value()=${called}"
}
```

`tests/agency/result/failure-method-call.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "split=yes origin=yes | hint=yes | value()=42",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "method calls on failures/successes throw rich catchable errors; r.value() on a function-wrapping success still works"
    }
  ]
}
```

- [ ] **Step 5: Plain TypeScript functions**

`tests/agency/result/failure-helpers.js`:

```js
export function tsFormat(x) {
  return "formatted:" + String(x);
}
```

`tests/agency/result/failure-ts-function.agency`:

```agency
import { tsFormat } from "./failure-helpers.js"

def getF(): Result {
  return failure("boom")
}

def callTs(v: any) {
  return tsFormat(v)
}

node main() {
  const f = getF()

  let untagged = "?"
  const r1 = try callTs(f)
  if (isFailure(r1)) {
    let hasHint = "no"
    if (r1.error.includes("acceptsFailures")) {
      hasHint = "yes"
    }
    untagged = "threw hint=${hasHint}"
  }

  const okValue = tsFormat("plain")

  const check = isFailure
  let aliased = "alias broken"
  if (check(f)) {
    aliased = "alias ok"
  }

  return "${untagged} | ${okValue} | ${aliased}"
}
```

`tests/agency/result/failure-ts-function.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "threw hint=yes | formatted:plain | alias ok",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "failure into an untagged TS function throws with the acceptsFailures hint; normal values pass; aliased isFailure works because it ships pre-tagged"
    }
  ]
}
```

- [ ] **Step 6: Array collection regression (guards the __call-only scan decision)**

`tests/agency/result/failure-array-collect.agency`:

```agency
def mightFail(n: number): Result {
  if (n % 2 == 0) {
    return failure("even ${n}")
  }
  return success(n)
}

node main() {
  const collected = []
  for (n in [1, 2, 3, 4]) {
    collected.push(mightFail(n))
  }
  let failures = 0
  for (r in collected) {
    if (isFailure(r)) {
      failures = failures + 1
    }
  }
  return "collected ${collected.length}, failures ${failures}"
}
```

`tests/agency/result/failure-array-collect.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "collected 4, failures 2",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "arr.push(someFailure) must work: method arguments are never scanned (the TS-function check lives in __call only)"
    }
  ]
}
```

- [ ] **Step 7: Block params fail open (pins the deliberate v1 carve-out)**

`tests/agency/result/failure-block-failopen.agency`:

```agency
def eachOf(items: any, block: (any) -> string): string {
  let out = ""
  for (item in items) {
    out = block(item)
  }
  return out
}

node main() {
  const mixed = [success(1), failure("bad")]
  const last = eachOf(mixed) as item {
    if (isFailure(item)) {
      return "block saw failure"
    }
    return "block saw value"
  }
  return last
}
```

`tests/agency/result/failure-block-failopen.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "block saw failure",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "block params always accept failures in v1 (emission sites carry no acceptsResult flags) — the block body runs and can guard with isFailure"
    }
  ]
}
```

- [ ] **Step 8: Async call propagation**

`tests/agency/result/failure-async-propagation.agency`:

```agency
def bad(): Result {
  return failure("boom")
}

def use(s: string) {
  return "used"
}

node main() {
  const f = bad()
  const x = async use(f)
  if (isFailure(x)) {
    return "async propagated ${x.error}"
  }
  return "async not propagated"
}
```

`tests/agency/result/failure-async-propagation.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "async propagated boom",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "an async call with a failure argument surfaces the propagated failure as its awaited result"
    }
  ]
}
```

- [ ] **Step 9: print must not be skipped (moved from Task 8)**

Create `tests/agency/result/failure-propagation-print.agency`:

```agency
def bad(): Result {
  return failure("boom")
}

node main() {
  const f = bad()
  const r = print(f)
  if (isFailure(r)) {
    return "print was skipped"
  }
  return "printed"
}
```

The `isFailure(r)` guard is what makes this test able to fail: if the `any[]` annotation is lost, the skip is otherwise silent (print's return value is normally discarded) and a bare `return "printed"` would pass with the feature broken. A skipped call returns the failure; a normal `print` returns its "Message printed." string.

And `tests/agency/result/failure-propagation-print.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "printed",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "print accepts a failure value under the strict rule (any[] variadic annotation); a skip would flip the output"
    }
  ]
}
```

- [ ] **Step 10: Run the nine tests**

Run each (after `make`), saving output:

```bash
make 2>&1 | tee /tmp/fp-task11-build.log
for t in failure-propagation-basic failure-propagation-modes failure-propagation-compose failure-method-call failure-ts-function failure-array-collect failure-block-failopen failure-async-propagation failure-propagation-print; do
  pnpm run agency test tests/agency/result/$t.agency 2>&1 | tee /tmp/fp-task11-$t.log
done
```

Expected: all PASS. Read the logs; do not rerun to re-inspect. If an expected-output string mismatches on an incidental detail (whitespace, JSON key order), fix the expected string to the observed value ONLY after confirming the observed behavior is correct per the spec.

- [ ] **Step 11: Commit**

```bash
git add -A tests
printf 'tests: agency execution coverage for failure propagation\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

---

### Task 12: Docs, lint, and validation sweep — PR #2

**Files:**
- Modify: `docs/site/guide/error-handling.md` (new section after "The `try` keyword")
- Modify: `docs/misc/config.md` (document the knob next to `maxCallDepth`)

**Interfaces:**
- Consumes: the strict default from Task 10 and the tests from Task 11.
- Produces: user-facing docs; PR #2 open with the triage protocol below.

- [ ] **Step 1: Guide section**

Add to `docs/site/guide/error-handling.md` after the `try` section:

```markdown
## Failure propagation

A failure is self-propagating. If you pass one to a function that is not
typed to accept Results, the function does not run. The call returns the
original failure instead, exactly like a pipe chain short-circuiting:

​```agency
def getReport(id: string): Result {
  return failure("HTTP 404: report not found")
}

def wordCount(text: string): number {
  return text.split(" ").length
}

node main() {
  const report = getReport("abc")   // oops: never checked
  const count = wordCount(report)   // wordCount is skipped
  // count IS the original failure. count.error is the 404 message, and
  // count.skippedFunctions is [{ name: "wordCount", param: "text" }].
}
​```

A parameter accepts failures only if its type says so. `Result`,
`Result<...>`, explicit `any`, or a union containing either accepts.
Untyped parameters reject.

Passing a failure to an imported TypeScript function throws an error
instead, because TypeScript code does not know about Results. Calling a
method on a Result (like `.split()` on a failure you forgot to unwrap)
also throws. Both errors name the function that produced the failure.

Set `failurePropagation` in `agency.json` to `"warn"` (log only) or
`"off"` to disable.
```

(Remove the zero-width markers around the inner fence when pasting; the inner block must be a real fenced `agency` block.)

- [ ] **Step 2: Config doc**

In `docs/misc/config.md`, add a row/entry next to `maxCallDepth`:

```markdown
- `failurePropagation` (`"off" | "warn" | "on"`, default `"on"`) — failure
  values passed to parameters not typed to accept Results skip the call and
  propagate; failures into TypeScript functions and method calls on Results
  throw. `"warn"` logs statelog warnings without changing behavior.
```

- [ ] **Step 3: Lint and full unit suite**

```bash
pnpm run lint:structure 2>&1 | tee /tmp/fp-task12-lint.log
pnpm test:run 2>&1 | tee /tmp/fp-task12-unit.log
```

Expected: both clean. Fix anything they flag.

- [ ] **Step 4: Commit and open PR #2 — CI is the corpus measurement**

```bash
git add -A docs
printf 'docs: failure propagation guide section and config knob\n' > /tmp/fp-msg.txt
git commit -F /tmp/fp-msg.txt
```

Then push the branch and open PR #2 (body written to a file, per global constraints). Because Stage 1 shipped in warn mode, this PR is a tiny diff: the default flip, the strict-default tests, and docs. Its CI run over the 841-program execution corpus IS the spec's rollout measurement. Triage protocol for CI failures, in order: (1) test legitimately passes a failure into an untyped param → annotate that param `any`/`Result` in the test or stdlib source; (2) message/output drift in an existing fixture → update the fixture after confirming the new behavior matches the spec; (3) anything else → treat as a real bug in this feature, fix before merging. If legitimate sites are widespread (double digits), stop and consult the owner — the fallback posture is simply not merging PR #2 yet, since main already works in warn mode.

---

## Deviations from the spec (pre-approved here)

- The spec's knob name `runtime.failurePropagation` maps to a top-level `failurePropagation` config key, because `AgencyConfig` keeps runtime knobs at top level (`maxCallDepth` precedent).
- The spec's rollout is honored via the two-PR staging above: PR #1 ships the mechanism with the ExecutionContext default at `"warn"` (the measurement posture), PR #2 flips it to `"on"` and its CI corpus run is the measurement. One addition beyond the spec: warn mode echoes each trip to stderr via `console.warn`, because the statelog event is invisible without observability config and warn mode exists to be seen.
- Per plan-review finding 1: the TS-function argument scan runs in `__call` ONLY. Method arguments (`__callMethod`) are never scanned — scanning them would break `arr.push(someFailure)` and every other native-prototype call that legitimately receives failures. The spec is updated to match.
- Per plan-review finding 2: block params always fail open in v1 (both block emission sites carry no `acceptsResult` flags — a deliberate carve-out, pinned by an execution test). The spec is updated to match.
