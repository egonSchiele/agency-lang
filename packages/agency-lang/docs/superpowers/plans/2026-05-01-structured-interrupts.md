# Structured Interrupts V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured shape (`kind`, `message`, `data`, `origin`) to Agency interrupts and provide a stdlib policy checker.

**Architecture:** Interrupt calls gain a new syntax `interrupt kind::name("message", { data })` parsed into a new AST node. The builder injects `origin` from the module ID and constructs the structured object passed to the runtime. A new `std::policy` stdlib module provides glob-based policy evaluation. Bare `interrupt("msg")` still works, desugaring to kind `"unknown"`.

**Tech Stack:** Tarsec (parser combinators), TypeScript IR, Mustache templates, picomatch (glob matching)

**Spec:** `docs/superpowers/specs/2026-05-01-structured-interrupts-design.md`

---

## File Map

### New files
- `lib/types/interruptStatement.ts` — AST node type for structured interrupt
- `lib/parsers/interruptStatement.ts` — Parser for `interrupt kind::name(args)`
- `lib/parsers/interruptStatement.test.ts` — Parser unit tests
- `lib/runtime/policy.ts` — `checkPolicy` and `validatePolicy` implementation
- `lib/runtime/policy.test.ts` — Policy unit tests
- `lib/runtime/origin.ts` — `moduleIdToOrigin()` mapping function
- `lib/runtime/origin.test.ts` — Origin mapping unit tests
- `stdlib/policy.agency` — Agency stdlib wrapper for policy functions
- `tests/agency/structured-interrupts/` — Directory for end-to-end tests (multiple .agency + .test.json files)

### Modified files
- `lib/types.ts` — Export new AST node type, add to `AgencyNode` union
- `lib/parser.ts` — Wire in the new interrupt parser
- `lib/runtime/interrupts.ts` — Add `kind`, `message`, `origin` fields to `Interrupt<T>`, update `interrupt()` factory and `interruptWithHandlers()`
- `lib/runtime/types.ts` — Update `HandlerFn` type signature
- `lib/backends/typescriptBuilder.ts` — Update interrupt detection and code generation to use new AST node and inject origin
- `lib/templates/backends/typescriptGenerator/interruptReturn.mustache` — Pass structured args
- `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache` — Pass structured args
- `lib/templates/cli/evaluate.mustache` — Fix `expectedMessage` comparison (use `interruptItem.message` instead of `interruptItem.data`)
- `lib/templates/cli/judgeEvaluate.mustache` — Same fix
- `stdlib/fs.agency` — Migrate interrupts to new syntax with `relPath`/`absPath`
- `stdlib/shell.agency` — Migrate interrupts to new syntax
- `stdlib/http.agency` — Migrate interrupts to new syntax
- `stdlib/system.agency` — Migrate interrupts to new syntax
- `stdlib/agent.agency` — Migrate interrupts to new syntax
- `stdlib/index.agency` — Migrate interrupts to new syntax with `relPath`/`absPath`
- `package.json` — Add `picomatch` dependency

---

## Task 1: Add `picomatch` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install picomatch**

Run: `pnpm add picomatch && pnpm add -D @types/picomatch`

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "add picomatch for glob matching in policy checker"
```

---

## Task 2: Add `kind`, `message`, `origin` to runtime `Interrupt<T>` type

**Files:**
- Modify: `lib/runtime/interrupts.ts`
- Modify: `lib/runtime/types.ts`

- [ ] **Step 1: Update `Interrupt<T>` type**

In `lib/runtime/interrupts.ts`, add new fields to the `Interrupt<T>` type (around line 53):

```typescript
export type Interrupt<T = any> = {
  type: "interrupt";
  kind: string;           // NEW — e.g. "std::read", "unknown"
  message: string;        // NEW — human-readable description
  origin: string;         // NEW — compiler-injected module origin
  interruptId: string;
  data: T;
  debugger?: boolean;
  interruptData?: InterruptData;
  checkpointId?: number;
  checkpoint?: Checkpoint;
  state?: InterruptState;
  runId: string;
};
```

- [ ] **Step 2: Update `interrupt()` factory function**

Update the factory function signature (around line 65):

```typescript
export function interrupt<T = any>(
  kind: string,
  message: string,
  data: T,
  origin: string,
  runId: string,
): Interrupt<T> {
  return {
    type: "interrupt",
    kind,
    message,
    origin,
    interruptId: nanoid(),
    data,
    runId,
  };
}
```

- [ ] **Step 3: Update `createDebugInterrupt` similarly**

Add `kind`, `message`, `origin` parameters to `createDebugInterrupt` (around line 74). For debug interrupts, use `kind: "debug"`, `message: ""`, `origin: ""`.

- [ ] **Step 4: Update `interruptWithHandlers`**

Change the function signature (around line 111) to accept structured fields. The key change: handlers now receive the full structured interrupt object, not just raw data.

```typescript
export async function interruptWithHandlers<T = any>(
  kind: string,
  message: string,
  data: T,
  origin: string,
  ctx: RuntimeContext<any>,
  stack?: StateStack,
): Promise<Interrupt<T>[] | Approved | Rejected> {
  const interruptObj = { kind, message, data, origin };
  if (ctx.handlers.length === 0) {
    return [interrupt(kind, message, data, origin, ctx.getRunId())];
  }
  // ... same logic but pass interruptObj to handlers instead of data:
  // result = await ctx.handlers[i](interruptObj);
```

- [ ] **Step 5: Update `HandlerFn` type**

In `lib/runtime/types.ts`, update the handler function type:

```typescript
export type HandlerFn = (
  interrupt: { kind: string; message: string; data: any; origin: string }
) => Promise<Approved | Rejected | Propagated | undefined>;
```

- [ ] **Step 6: Fix all callers of `interrupt()` and `interruptWithHandlers()` in the runtime**

Search for all calls to `interrupt(` and `interruptWithHandlers(` in `lib/runtime/` and update their arguments. Key locations:
- `lib/runtime/interrupts.ts` — the `interruptWithHandlers` function itself (where it calls `interrupt()`)
- `lib/runtime/runner.ts` — if it calls `interrupt()` directly anywhere
- Debug interrupt creation

Run: `pnpm test:run 2>&1 | head -100` to see what breaks. Fix compilation errors.

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/interrupts.ts lib/runtime/types.ts
git commit -m "add kind, message, origin fields to Interrupt type and update factory"
```

---

## Task 3: Origin derivation utility

**Files:**
- Create: `lib/runtime/origin.ts`
- Create: `lib/runtime/origin.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// lib/runtime/origin.test.ts
import { describe, it, expect } from "vitest";
import { moduleIdToOrigin } from "./origin.js";

describe("moduleIdToOrigin", () => {
  it("maps stdlib paths to std:: namespace", () => {
    expect(moduleIdToOrigin("stdlib/fs.agency")).toBe("std::fs");
    expect(moduleIdToOrigin("stdlib/shell.agency")).toBe("std::shell");
    expect(moduleIdToOrigin("stdlib/http.agency")).toBe("std::http");
    expect(moduleIdToOrigin("stdlib/index.agency")).toBe("std::index");
  });

  it("maps local files to ./ relative paths", () => {
    expect(moduleIdToOrigin("foo.agency")).toBe("./foo.agency");
    expect(moduleIdToOrigin("src/agents/deploy.agency")).toBe("./src/agents/deploy.agency");
  });

  it("maps package paths to pkg:: namespace", () => {
    expect(moduleIdToOrigin("node_modules/my-pkg/index.agency")).toBe("pkg::my-pkg");
    expect(moduleIdToOrigin("node_modules/@scope/pkg/foo.agency")).toBe("pkg::@scope/pkg/foo");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/runtime/origin.test.ts 2>&1 | tee /tmp/origin-test.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `moduleIdToOrigin`**

```typescript
// lib/runtime/origin.ts
export function moduleIdToOrigin(moduleId: string): string {
  // stdlib/foo.agency → std::foo
  const stdlibMatch = moduleId.match(/^(?:.*\/)?stdlib\/(.+)\.agency$/);
  if (stdlibMatch) {
    return `std::${stdlibMatch[1]}`;
  }

  // node_modules/pkg-name/... → pkg::pkg-name/...
  const pkgMatch = moduleId.match(/^(?:.*\/)?node_modules\/(.+?)\/(.+)\.agency$/);
  if (pkgMatch) {
    const subpath = pkgMatch[2];
    if (subpath === "index") {
      return `pkg::${pkgMatch[1]}`;
    }
    return `pkg::${pkgMatch[1]}/${subpath}`;
  }

  // local file → ./path
  return `./${moduleId}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- lib/runtime/origin.test.ts 2>&1 | tee /tmp/origin-test.log`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/origin.ts lib/runtime/origin.test.ts
git commit -m "add moduleIdToOrigin utility for deriving interrupt origin"
```

---

## Task 4: AST node type for structured interrupt

**Files:**
- Create: `lib/types/interruptStatement.ts`
- Modify: `lib/types.ts`

- [ ] **Step 1: Define the AST node type**

```typescript
// lib/types/interruptStatement.ts
import { BaseNode } from "./base.js";
import { Expression } from "../types.js";
import { SplatExpression } from "./splatExpression.js";
import { NamedArgument } from "./namedArgument.js";

export type InterruptStatement = BaseNode & {
  type: "interruptStatement";
  kind: string;                    // e.g. "std::read", "myapp::deploy"
  arguments: (Expression | SplatExpression | NamedArgument)[];   // [message, data?]
};
```

Note: Check `lib/types/base.ts` for the exact `BaseNode` import path and `lib/types/function.ts` for the argument type used by `FunctionCall`. Follow those exact patterns.

- [ ] **Step 2: Export from `lib/types.ts` and add to `AgencyNode` union**

Add `import { InterruptStatement } from "./types/interruptStatement.js"` and add `InterruptStatement` to the `AgencyNode` union type and re-export it.

- [ ] **Step 3: Commit**

```bash
git add lib/types/interruptStatement.ts lib/types.ts
git commit -m "add InterruptStatement AST node type"
```

---

## Task 5: Parser for structured interrupt syntax

**Files:**
- Create: `lib/parsers/interruptStatement.ts`
- Create: `lib/parsers/interruptStatement.test.ts`
- Modify: `lib/parser.ts`

- [ ] **Step 1: Write failing parser tests**

Create `lib/parsers/interruptStatement.test.ts` with tests for:
- `interrupt std::read("msg", { filename: "foo" })` → parsed as `InterruptStatement` with kind `"std::read"` and 2 arguments
- `interrupt std::read("msg")` → kind `"std::read"`, 1 argument
- `interrupt myapp::deploy("msg", { env: "prod" })` → kind `"myapp::deploy"`, 2 arguments
- `interrupt std::http::fetch("msg")` → kind `"std::http::fetch"`, 1 argument
- Bare `interrupt("msg")` should NOT match this parser (it stays as a FunctionCall)

Use the existing parser test patterns from other files in `lib/parsers/`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/parsers/interruptStatement.test.ts 2>&1 | tee /tmp/interrupt-parser-test.log`

- [ ] **Step 3: Implement the parser**

Create `lib/parsers/interruptStatement.ts`. The parser should:
1. Match the keyword `interrupt`
2. Match a namespace identifier: one or more segments separated by `::` (e.g., `std::read`, `myapp::deploy`, `std::http::fetch`)
3. Match `(args)` using the existing argument list parser

Use tarsec combinators. Look at how other parsers in `lib/parsers/` are structured. The namespace identifier parser needs to handle the `::` separator — look at how `std::` is parsed for imports in `lib/parsers/importStatement.ts` or similar.

Key: bare `interrupt("msg")` must NOT match this parser — it should continue to be parsed as a regular function call. The distinguishing feature is the namespace identifier between `interrupt` and `(`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- lib/parsers/interruptStatement.test.ts 2>&1 | tee /tmp/interrupt-parser-test.log`

- [ ] **Step 5: Wire into main parser**

In `lib/parser.ts`, add the new interrupt parser to the statement parser list. It must be tried BEFORE the function call parser (since `interrupt foo::bar(...)` would otherwise partially match as a function call to `interrupt`).

- [ ] **Step 6: Verify existing tests still pass**

Run: `pnpm test:run 2>&1 | tee /tmp/all-tests.log`
Check for regressions, especially in interrupt-related tests.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/interruptStatement.ts lib/parsers/interruptStatement.test.ts lib/parser.ts
git commit -m "add parser for structured interrupt syntax"
```

---

## Task 6: Builder — generate structured interrupt code

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`
- Modify: `lib/templates/backends/typescriptGenerator/interruptReturn.mustache`
- Modify: `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache`

- [ ] **Step 1: Update builder to handle `InterruptStatement` AST node**

In `typescriptBuilder.ts`, add a new case in `processNode` (or wherever node types are dispatched) for `"interruptStatement"`. This case should:

1. Extract `kind` from the AST node
2. Compute `origin` using `moduleIdToOrigin(this.moduleId)`
3. Extract `message` (first argument) and `data` (second argument, defaulting to `{}`)
4. Pass these as template parameters

For the existing bare `interrupt()` function call path (the `if (node.functionName === "interrupt")` case), update it to pass `kind: "unknown"`, `origin: moduleIdToOrigin(this.moduleId)`, and treat the single argument as `message` with `data: {}`.

- [ ] **Step 2: Update `interruptReturn.mustache`**

Change the `interruptWithHandlers` call from:
```
interruptWithHandlers({{{interruptArgs}}}, __ctx, __stateStack)
```
to:
```
interruptWithHandlers({{{kind}}}, {{{message}}}, {{{data}}}, {{{origin}}}, __ctx, __stateStack)
```

Run `pnpm run templates` after editing the mustache file.

- [ ] **Step 3: Update `interruptAssignment.mustache`**

Same change as step 2.

Run `pnpm run templates` after editing.

- [ ] **Step 4: Run tests to check for compilation/generation issues**

Run: `pnpm test:run 2>&1 | tee /tmp/builder-tests.log`

Many existing tests will likely break because the generated code now passes different arguments to `interruptWithHandlers`. This is expected — the handler tests need updating. Fix any unexpected failures.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/templates/backends/typescriptGenerator/interruptReturn.mustache lib/templates/backends/typescriptGenerator/interruptAssignment.mustache
git commit -m "generate structured interrupt code with kind, message, data, origin"
```

---

## Task 7: Update existing handler tests for new interrupt shape

**Files:**
- Modify: Multiple files in `tests/agency/handlers/` and `tests/agency/`

- [ ] **Step 1: Update handler .agency files**

The handler parameter now receives `{ kind, message, data, origin }` instead of raw data. Tests that access the handler parameter need updating.

For example, in tests that do `with (data) { ... }`, the `data` variable now contains the structured object. Tests that check `data` directly (like comparing to a string) need to check `data.message` or `data.data` instead.

Review each file in `tests/agency/handlers/` and each interrupt-related test. Most tests use `with approve` shorthand or don't inspect the data, so they should be fine. Focus on tests that actually access the handler parameter.

- [ ] **Step 2: Fix test runner `expectedMessage` comparison (CRITICAL)**

The test runner templates at `lib/templates/cli/evaluate.mustache` (line ~27) and `lib/templates/cli/judgeEvaluate.mustache` (line ~27) compare `interruptItem.data` against `handler.expectedMessage`. After the structured interrupt change, the message is at `interruptItem.message`, not `interruptItem.data`.

Change `interruptItem.data` to `interruptItem.message` in both templates. Then run `pnpm run templates` to recompile them.

**This is blocking for all 120+ existing tests with `interruptHandlers` in their test.json files.**

- [ ] **Step 3: Run all tests**

Run: `pnpm test:run 2>&1 | tee /tmp/handler-tests.log`
Fix any remaining failures.

- [ ] **Step 4: Commit**

```bash
git add tests/agency/ lib/
git commit -m "update existing tests for structured interrupt shape"
```

---

## Task 8: Policy checker implementation

**Files:**
- Create: `lib/runtime/policy.ts`
- Create: `lib/runtime/policy.test.ts`

- [ ] **Step 1: Write failing unit tests**

```typescript
// lib/runtime/policy.test.ts
import { describe, it, expect } from "vitest";
import { checkPolicy, validatePolicy } from "./policy.js";

describe("checkPolicy", () => {
  it("returns propagate when no rules exist for the kind", () => {
    const policy = {};
    const interrupt = { kind: "std::read", message: "msg", data: { filename: "foo" }, origin: "std::fs" };
    const result = checkPolicy(policy, interrupt);
    expect(result).toEqual({ type: "propagate" });
  });

  it("matches exact field value (glob with no wildcards)", () => {
    const policy = {
      "test::greet": [
        { match: { name: "Alice" }, action: "allow" },
        { action: "deny" },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "test::greet", message: "", data: { name: "Bob" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("matches glob patterns with *", () => {
    const policy = {
      "test::cmd": [
        { match: { command: "ls *" }, action: "allow" },
        { action: "deny" },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::cmd", message: "", data: { command: "ls -la" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "test::cmd", message: "", data: { command: "rm -rf" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("matches glob patterns with ** for paths", () => {
    const policy = {
      "test::read": [
        { match: { path: "src/**" }, action: "allow" },
        { action: "deny" },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::read", message: "", data: { path: "src/foo/bar.ts" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "test::read", message: "", data: { path: "dist/foo.js" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("uses first-match-wins ordering", () => {
    const policy = {
      "test::greet": [
        { match: { name: "Alice" }, action: "deny" },
        { match: { name: "Ali*" }, action: "allow" },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("skips rules when match field is missing from data", () => {
    const policy = {
      "test::greet": [
        { match: { email: "alice@*" }, action: "deny" },
        { action: "allow" },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "approve" });
  });

  it("matches on origin (special key)", () => {
    const policy = {
      "std::read": [
        { match: { origin: "std::*" }, action: "allow" },
        { action: "deny" },
      ],
    };
    expect(checkPolicy(policy, { kind: "std::read", message: "", data: {}, origin: "std::fs" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "std::read", message: "", data: {}, origin: "./myfile.agency" }))
      .toEqual({ type: "reject" });
  });

  it("matches on message (special key)", () => {
    const policy = {
      "test::x": [
        { match: { message: "Are you sure*" }, action: "allow" },
        { action: "deny" },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::x", message: "Are you sure about this?", data: {}, origin: "" }))
      .toEqual({ type: "approve" });
  });

  it("ANDs all match fields together", () => {
    const policy = {
      "test::cmd": [
        { match: { command: "rm *", dir: "/tmp/*" }, action: "allow" },
        { action: "deny" },
      ],
    };
    // Both match
    expect(checkPolicy(policy, { kind: "test::cmd", message: "", data: { command: "rm foo", dir: "/tmp/x" }, origin: "" }))
      .toEqual({ type: "approve" });
    // command matches but dir doesn't
    expect(checkPolicy(policy, { kind: "test::cmd", message: "", data: { command: "rm foo", dir: "/home/x" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("catch-all rule (no match) matches everything", () => {
    const policy = {
      "test::x": [{ action: "allow" }],
    };
    expect(checkPolicy(policy, { kind: "test::x", message: "", data: { anything: "whatever" }, origin: "" }))
      .toEqual({ type: "approve" });
  });

  it("maps deny action to reject type", () => {
    const policy = {
      "test::x": [{ action: "deny" }],
    };
    const result = checkPolicy(policy, { kind: "test::x", message: "", data: {}, origin: "" });
    expect(result).toEqual({ type: "reject" });
  });
});

describe("validatePolicy", () => {
  it("accepts a valid policy", () => {
    const result = validatePolicy({
      "std::read": [{ match: { filename: "*.md" }, action: "allow" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action strings", () => {
    const result = validatePolicy({
      "std::read": [{ action: "yolo" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array rule values", () => {
    const result = validatePolicy({
      "std::read": "allow",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/runtime/policy.test.ts 2>&1 | tee /tmp/policy-test.log`

- [ ] **Step 3: Implement `checkPolicy` and `validatePolicy`**

```typescript
// lib/runtime/policy.ts
import picomatch from "picomatch";

type PolicyRule = {
  match?: Record<string, string>;
  action: "allow" | "deny" | "propagate";
};

type Policy = Record<string, PolicyRule[]>;

type PolicyResult =
  | { type: "approve" }
  | { type: "reject" }
  | { type: "propagate" };

const SPECIAL_KEYS = ["origin", "message"] as const;

export function checkPolicy(
  policy: Policy,
  interrupt: { kind: string; message: string; data: any; origin: string },
): PolicyResult {
  const rules = policy[interrupt.kind];
  if (!rules) {
    return { type: "propagate" };
  }

  for (const rule of rules) {
    if (matchesRule(rule, interrupt)) {
      return actionToResult(rule.action);
    }
  }

  return { type: "propagate" };
}

function matchesRule(
  rule: PolicyRule,
  interrupt: { kind: string; message: string; data: any; origin: string },
): boolean {
  if (!rule.match) return true; // catch-all

  for (const [key, pattern] of Object.entries(rule.match)) {
    let value: string | undefined;
    if (key === "origin") {
      value = interrupt.origin;
    } else if (key === "message") {
      value = interrupt.message;
    } else {
      value = interrupt.data?.[key];
    }

    if (value === undefined) return false;
    if (typeof value !== "string") value = String(value);

    if (!picomatch.isMatch(value, pattern)) return false;
  }

  return true;
}

function actionToResult(action: string): PolicyResult {
  switch (action) {
    case "allow": return { type: "approve" };
    case "deny": return { type: "reject" };
    case "propagate": return { type: "propagate" };
    default: return { type: "propagate" };
  }
}

export function validatePolicy(policy: any): { success: boolean; error?: string } {
  if (typeof policy !== "object" || policy === null) {
    return { success: false, error: "Policy must be an object" };
  }
  for (const [kind, rules] of Object.entries(policy)) {
    if (!Array.isArray(rules)) {
      return { success: false, error: `Rules for "${kind}" must be an array` };
    }
    for (const rule of rules as any[]) {
      if (!rule.action || !["allow", "deny", "propagate"].includes(rule.action)) {
        return { success: false, error: `Invalid action in rules for "${kind}": ${rule.action}` };
      }
    }
  }
  return { success: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- lib/runtime/policy.test.ts 2>&1 | tee /tmp/policy-test.log`

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/policy.ts lib/runtime/policy.test.ts
git commit -m "implement checkPolicy and validatePolicy with glob matching"
```

---

## Task 9: Stdlib `policy.agency` wrapper

**Files:**
- Create: `stdlib/policy.agency`

- [ ] **Step 1: Create the Agency stdlib file**

```
import { _checkPolicy, _validatePolicy } from "./lib/policy.js"

export def checkPolicy(policy: object, interrupt: object) {
  return _checkPolicy(policy, interrupt)
}

export def validatePolicy(policy: object) {
  return _validatePolicy(policy)
}
```

Note: The actual implementation lives in TypeScript (`lib/runtime/policy.ts`). The stdlib `.agency` file is a thin wrapper that imports from the compiled JS. Check how other stdlib files (like `fs.agency`, `shell.agency`) import their backing implementations from `./lib/*.js` and follow the same pattern.

- [ ] **Step 2: Create the TypeScript backing file**

Create the corresponding `stdlib/lib/policy.ts` (or `.js`) file that re-exports from `lib/runtime/policy.ts`. Look at how other stdlib backing files are structured (e.g., `stdlib/lib/builtins.ts` or similar).

- [ ] **Step 3: Compile and verify**

Run: `pnpm run templates && pnpm run build`
Verify no compilation errors.

- [ ] **Step 4: Commit**

```bash
git add stdlib/policy.agency stdlib/lib/
git commit -m "add std::policy stdlib module"
```

---

## Task 10: Migrate stdlib interrupts to new syntax

**Files:**
- Modify: `stdlib/fs.agency`
- Modify: `stdlib/shell.agency`
- Modify: `stdlib/http.agency`
- Modify: `stdlib/system.agency`
- Modify: `stdlib/agent.agency`
- Modify: `stdlib/index.agency`

- [ ] **Step 1: Migrate `stdlib/fs.agency`**

Change each interrupt from:
```
return interrupt({
  type: "std::edit",
  message: "Are you sure you want to edit this file?",
  filename: filename,
  oldText: oldText,
  newText: newText,
  replaceAll: replaceAll
})
```
to:
```
const absPath = resolve(filename)
return interrupt std::edit("Are you sure you want to edit this file?", {
  relPath: filename,
  absPath: absPath,
  oldText: oldText,
  newText: newText,
  replaceAll: replaceAll
})
```

Import `resolve` from `std::path` (it's `path.resolve`). Apply to all functions: `edit`, `multiedit`, `applyPatch`, `mkdir`, `copy`, `move`, `remove`. For `copy` and `move`, use `srcRelPath`/`srcAbsPath`/`destRelPath`/`destAbsPath`.

- [ ] **Step 2: Migrate `stdlib/shell.agency`**

Same pattern for `bash`, `ls`, `grep`, `glob`. For `bash`, the `cwd` field stays as-is (it's a working directory, not a file path being operated on).

- [ ] **Step 3: Migrate `stdlib/http.agency`**

Change `std::http.fetch` → `std::http::fetch`, etc.

- [ ] **Step 4: Migrate `stdlib/system.agency`**

Change `std::system.setEnv` → `std::system::setEnv`.

- [ ] **Step 5: Migrate `stdlib/agent.agency`**

Fix `std::question` — use only `prompt` in data (remove the duplicate `message` field in data).

- [ ] **Step 6: Migrate `stdlib/index.agency`**

Same pattern for `read`, `write`, `readImage`, `fetch`, `fetchJSON`, `notify`. Add `relPath`/`absPath` for file operations.

- [ ] **Step 7: Compile and test**

Run: `pnpm run build && pnpm test:run 2>&1 | tee /tmp/stdlib-migration.log`

- [ ] **Step 8: Commit**

```bash
git add stdlib/
git commit -m "migrate stdlib interrupts to structured syntax with relPath/absPath"
```

---

## Task 11: End-to-end agency tests for structured interrupts

**Files:**
- Create: `tests/agency/structured-interrupts/structured-interrupt-handler.agency`
- Create: `tests/agency/structured-interrupts/structured-interrupt-handler.test.json`
- Create: `tests/agency/structured-interrupts/bare-interrupt-backward-compat.agency`
- Create: `tests/agency/structured-interrupts/bare-interrupt-backward-compat.test.json`

- [ ] **Step 1: Test that handler receives structured data**

```
// tests/agency/structured-interrupts/structured-interrupt-handler.agency
def check(name: string) {
  return interrupt mytest::greet("May I greet?", { name: name })
  return "Hello, ${name}!"
}

node main() {
  handle {
    return check("Alice")
  } with (interrupt) {
    if (interrupt.kind == "mytest::greet") {
      if (interrupt.data.name == "Alice") {
        return approve()
      }
    }
    return reject()
  }
}
```

```json
// tests/agency/structured-interrupts/structured-interrupt-handler.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Handler receives structured interrupt with kind and data fields",
      "input": "",
      "expectedOutput": "\"Hello, Alice!\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Test bare interrupt backward compatibility**

```
// tests/agency/structured-interrupts/bare-interrupt-backward-compat.agency
def check() {
  return interrupt("Are you sure?")
  return "confirmed"
}

node main() {
  handle {
    return check()
  } with (interrupt) {
    if (interrupt.kind == "unknown") {
      return approve()
    }
    return reject()
  }
}
```

```json
// tests/agency/structured-interrupts/bare-interrupt-backward-compat.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Bare interrupt desugars to kind unknown and handler can match it",
      "input": "",
      "expectedOutput": "\"confirmed\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Test assignment form of structured interrupt**

```
// tests/agency/structured-interrupts/structured-interrupt-assign.agency
def askName() {
  const name = interrupt mytest::ask("What is your name?", { default: "World" })
  return "Hello, ${name}!"
}

node main() {
  handle {
    return askName()
  } with (interrupt) {
    if (interrupt.kind == "mytest::ask") {
      return approve("Alice")
    }
    return reject()
  }
}
```

```json
// tests/agency/structured-interrupts/structured-interrupt-assign.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Assignment form of structured interrupt receives value from handler",
      "input": "",
      "expectedOutput": "\"Hello, Alice!\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 4: Test origin is injected correctly**

```
// tests/agency/structured-interrupts/structured-interrupt-origin.agency
def check() {
  return interrupt mytest::check("confirm", {})
  return "ok"
}

node main() {
  handle {
    return check()
  } with (interrupt) {
    // origin should be the relative path of this file
    return approve(interrupt.origin)
  }
}
```

```json
// tests/agency/structured-interrupts/structured-interrupt-origin.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Interrupt origin is injected by compiler as the module path",
      "input": "",
      "expectedOutput": "\"ok\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

Note: The expected output is `"ok"` because the handler approves (with the origin value), and execution continues past the interrupt to `return "ok"`. The origin value is returned from `approve()` but the interrupt is in return position, so execution continues. To actually test the origin value, you may need to use the assignment form instead. Adjust based on how the interrupt-gate idiom interacts with `approve(value)`.

- [ ] **Step 5: Test backward compatibility — `with approve` shorthand**

```
// tests/agency/structured-interrupts/with-approve-shorthand.agency
def check() {
  return interrupt mytest::check("confirm", {})
  return "ok"
}

node main() {
  return check() with approve
}
```

```json
// tests/agency/structured-interrupts/with-approve-shorthand.test.json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "with approve shorthand still works with structured interrupts",
      "input": "",
      "expectedOutput": "\"ok\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm run a test tests/agency/structured-interrupts/ 2>&1 | tee /tmp/structured-tests.log`

- [ ] **Step 7: Commit**

```bash
git add tests/agency/structured-interrupts/
git commit -m "add end-to-end tests for structured interrupts"
```

---

## Task 12: End-to-end agency tests for checkPolicy

**Files:**
- Create: `tests/agency/structured-interrupts/policy-exact-match.agency` + `.test.json`
- Create: `tests/agency/structured-interrupts/policy-glob-match.agency` + `.test.json`
- Create: `tests/agency/structured-interrupts/policy-first-match-wins.agency` + `.test.json`
- Create: `tests/agency/structured-interrupts/policy-missing-field.agency` + `.test.json`
- Create: `tests/agency/structured-interrupts/policy-unknown-propagate.agency` + `.test.json`

- [ ] **Step 1: Test policy exact match (allow Alice, deny Bob)**

```
// tests/agency/structured-interrupts/policy-exact-match.agency
import { checkPolicy } from "std::policy"

def greet(name: string): string {
  return interrupt mytest::greet("May I greet?", { name: name })
  return "Hello, ${name}!"
}

node main() {
  const policy = {
    "mytest::greet": [
      { "match": { "name": "Alice" }, "action": "allow" },
      { "action": "deny" }
    ]
  }
  handle {
    const r1 = greet("Alice")
    const r2 = greet("Bob") catch "denied"
    return { r1: r1, r2: r2 }
  } with (interrupt) {
    return checkPolicy(policy, interrupt)
  }
}
```

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Policy allows Alice by exact match and denies Bob via catch-all",
      "input": "",
      "expectedOutput": "{\"r1\":\"Hello, Alice!\",\"r2\":\"denied\"}",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Test policy glob match on paths**

```
// tests/agency/structured-interrupts/policy-glob-match.agency
import { checkPolicy } from "std::policy"

def writeLog(msg: string, relPath: string): string {
  return interrupt mytest::log("May I log?", { relPath: relPath })
  return "Logged to ${relPath}"
}

node main() {
  const policy = {
    "mytest::log": [
      { "match": { "relPath": "logs/*" }, "action": "allow" },
      { "action": "deny" }
    ]
  }
  handle {
    const r1 = writeLog("info", "logs/app.log")
    const r2 = writeLog("secret", "secrets/keys.txt") catch "denied"
    return { r1: r1, r2: r2 }
  } with (interrupt) {
    return checkPolicy(policy, interrupt)
  }
}
```

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Policy allows logs/* path via glob and denies others",
      "input": "",
      "expectedOutput": "{\"r1\":\"Logged to logs/app.log\",\"r2\":\"denied\"}",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Test first-match-wins ordering**

```
// tests/agency/structured-interrupts/policy-first-match-wins.agency
import { checkPolicy } from "std::policy"

def greet(name: string): string {
  return interrupt mytest::greet("May I greet?", { name: name })
  return "Hello, ${name}!"
}

node main() {
  const policy = {
    "mytest::greet": [
      { "match": { "name": "Alice" }, "action": "deny" },
      { "match": { "name": "Ali*" }, "action": "allow" },
      { "action": "deny" }
    ]
  }
  handle {
    const r1 = greet("Alice") catch "denied"
    return r1
  } with (interrupt) {
    return checkPolicy(policy, interrupt)
  }
}
```

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "First matching rule wins - exact deny before glob allow",
      "input": "",
      "expectedOutput": "\"denied\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 4: Test missing field — rule skipped**

```
// tests/agency/structured-interrupts/policy-missing-field.agency
import { checkPolicy } from "std::policy"

def greet(name: string): string {
  return interrupt mytest::greet("May I greet?", { name: name })
  return "Hello, ${name}!"
}

node main() {
  const policy = {
    "mytest::greet": [
      { "match": { "email": "alice@*" }, "action": "deny" },
      { "action": "allow" }
    ]
  }
  handle {
    return greet("Alice")
  } with (interrupt) {
    return checkPolicy(policy, interrupt)
  }
}
```

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Rule with missing field in data is skipped, falls through to catch-all",
      "input": "",
      "expectedOutput": "\"Hello, Alice!\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 5: Test unknown kind propagates**

```
// tests/agency/structured-interrupts/policy-unknown-propagate.agency
import { checkPolicy } from "std::policy"

def confirm() {
  return interrupt("Are you sure?")
  return "confirmed"
}

node main() {
  const policy = {
    "mytest::greet": [
      { "action": "allow" }
    ]
  }
  handle {
    return confirm()
  } with (interrupt) {
    return checkPolicy(policy, interrupt)
  }
}
```

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Bare interrupt with no matching policy propagates to user",
      "input": "",
      "expectedOutput": "\"confirmed\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        {
          "action": "approve",
          "expectedMessage": "Are you sure?"
        }
      ]
    }
  ]
}
```

Note: This test verifies that `checkPolicy` returns `propagate()`, which means the interrupt escapes the handler and propagates to the user. The `interruptHandlers` in the test.json then approve it externally.

- [ ] **Step 6: Run all policy tests**

Run: `pnpm run a test tests/agency/structured-interrupts/ 2>&1 | tee /tmp/policy-e2e-tests.log`

- [ ] **Step 7: Commit**

```bash
git add tests/agency/structured-interrupts/
git commit -m "add end-to-end policy tests: exact match, glob, first-match-wins, missing field, unknown"
```

---

## Task 13: Rebuild fixtures and final verification

**Files:**
- Various fixture files

- [ ] **Step 1: Rebuild all test fixtures**

Run: `make fixtures`

This regenerates the compiled output fixtures for integration tests.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test:run 2>&1 | tee /tmp/final-tests.log`

Check for any remaining failures. All existing tests should pass alongside the new ones.

- [ ] **Step 3: Fix any remaining failures**

Address any test failures found in step 2.

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "rebuild fixtures for structured interrupts"
```
