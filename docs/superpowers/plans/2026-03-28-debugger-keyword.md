# Debugger Keyword Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `debugger` keyword that acts as a special interrupt (with `debugger: true`), plus a debugger mode that auto-inserts breakpoints before every step.

**Architecture:** The debugger is a thin layer on existing interrupt infrastructure. A `debuggerStatement` AST node compiles to interrupt code with a `debugger: true` flag, bypassing handlers. Debugger mode inserts these nodes in the builder's `processBodyAsParts()` when `config.debugger` is true.

**Tech Stack:** TypeScript, tarsec (parser combinators), vitest (testing)

**Spec:** `docs/superpowers/specs/2026-03-28-debugger-keyword-design.md`

---

### Task 1: AST Type and Runtime Types

**Files:**
- Create: `lib/types/debuggerStatement.ts`
- Modify: `lib/types.ts`
- Modify: `lib/runtime/interrupts.ts`
- Modify: `lib/runtime/index.ts`

- [ ] **Step 1: Create the DebuggerStatement AST node type**

Create `lib/types/debuggerStatement.ts`:

```typescript
import type { BaseNode } from "./base.js";

export type DebuggerStatement = BaseNode & {
  type: "debuggerStatement";
  label?: string;
};
```

- [ ] **Step 2: Add DebuggerStatement to the AgencyNode union**

In `lib/types.ts`:
- Add import: `import { DebuggerStatement } from "./types/debuggerStatement.js";`
- Add export: `export * from "./types/debuggerStatement.js";`
- Add `| DebuggerStatement` to the `AgencyNode` union type (after `| Sentinel`)

- [ ] **Step 3: Add `debugger` field to the Interrupt type**

In `lib/runtime/interrupts.ts`, add `debugger?: boolean` to the `Interrupt` type (line ~57-65):

```typescript
export type Interrupt<T = any> = {
  type: "interrupt";
  data: T;
  debugger?: boolean;  // NEW
  interruptData?: InterruptData;
  checkpointId?: number;
  checkpoint?: Checkpoint;
  state?: InterruptState;
};
```

- [ ] **Step 4: Add `isDebugger()` function**

In `lib/runtime/interrupts.ts`, add after the `isInterrupt` function (line ~77):

```typescript
export function isDebugger(obj: any): obj is Interrupt {
  return isInterrupt(obj) && obj.debugger === true;
}
```

- [ ] **Step 5: Export `isDebugger` from the runtime**

In `lib/runtime/index.ts`, add `isDebugger` to the interrupt exports block (line ~46-58):

```typescript
export {
  interrupt,
  isInterrupt,
  isDebugger,   // NEW
  isRejected,
  ...
} from "./interrupts.js";
```

- [ ] **Step 5b: Export `isDebugger` from compiled Agency code**

The compiled `.js` output of Agency files exports `isInterrupt` for callers. `isDebugger` should be exported the same way. Check the imports template at `lib/templates/backends/typescriptGenerator/imports.mustache` — find where `isInterrupt` is imported from `agency-lang/runtime` and add `isDebugger` next to it. Also check the exports template to ensure it gets re-exported.

- [ ] **Step 6: Write unit tests for isDebugger**

Create `lib/runtime/isDebugger.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { interrupt, isDebugger, isInterrupt } from "./interrupts.js";

describe("isDebugger", () => {
  it("returns true for an interrupt with debugger: true", () => {
    const i = interrupt("breakpoint");
    i.debugger = true;
    expect(isDebugger(i)).toBe(true);
  });

  it("returns false for a regular interrupt", () => {
    const i = interrupt("regular");
    expect(isDebugger(i)).toBe(false);
  });

  it("returns false for non-interrupt values", () => {
    expect(isDebugger(null)).toBe(false);
    expect(isDebugger(undefined)).toBe(false);
    expect(isDebugger({ type: "other" })).toBe(false);
    expect(isDebugger("string")).toBe(false);
  });

  it("returns false for interrupt with debugger: false", () => {
    const i = interrupt("breakpoint");
    i.debugger = false;
    expect(isDebugger(i)).toBe(false);
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/isDebugger.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 8: Commit**

```bash
git add lib/types/debuggerStatement.ts lib/types.ts lib/runtime/interrupts.ts lib/runtime/index.ts lib/runtime/isDebugger.test.ts
git commit -m "feat: add DebuggerStatement AST type, Interrupt.debugger flag, and isDebugger()"
```

---

### Task 2: Parser

**Files:**
- Create: `lib/parsers/debuggerStatement.ts`
- Create: `lib/parsers/debuggerStatement.test.ts`
- Modify: `lib/parser.ts`

**Reference:** Look at `lib/parsers/returnStatement.ts` for the pattern. The `debugger` parser is simpler — it's a keyword with an optional parenthesized string argument.

- [ ] **Step 1: Write the parser test**

Create `lib/parsers/debuggerStatement.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { debuggerParser } from "./debuggerStatement.js";

describe("debuggerParser", () => {
  it("parses bare debugger statement", () => {
    const result = debuggerParser("debugger");
    expect(result.success).toBe(true);
    expect(result.result).toEqual(
      expect.objectContaining({
        type: "debuggerStatement",
      }),
    );
    expect(result.result.label).toBeUndefined();
  });

  it("parses debugger with label", () => {
    const result = debuggerParser('debugger("checking mood")');
    expect(result.success).toBe(true);
    expect(result.result).toEqual(
      expect.objectContaining({
        type: "debuggerStatement",
        label: "checking mood",
      }),
    );
  });

  it("parses debugger with single-quoted label", () => {
    const result = debuggerParser("debugger('my label')");
    expect(result.success).toBe(true);
    expect(result.result).toEqual(
      expect.objectContaining({
        type: "debuggerStatement",
        label: "my label",
      }),
    );
  });

  it("does not parse debuggerFoo as debugger", () => {
    const result = debuggerParser("debuggerFoo");
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/parsers/debuggerStatement.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the parser implementation**

Create `lib/parsers/debuggerStatement.ts`. The parser must:
- Match the literal string `debugger` or the function `debugger()`
- Ensure it's not followed by a word character (so `debuggerFoo` doesn't match)
- Optionally match `("label string")` after it

```typescript
import { capture, optional, Parser, seqC, set, str, regex } from "tarsec";
import { DebuggerStatement } from "../types/debuggerStatement.js";
import { optionalSemicolon } from "./parserUtils.js";

const debuggerLabel: Parser<string> = (input: string) => {
  const match = input.match(/^\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/);
  if (!match) return { success: false, rest: input };
  const label = match[1] ?? match[2];
  return { success: true, result: label, rest: input.slice(match[0].length) };
};

export const debuggerParser: Parser<DebuggerStatement> = (input: string) => {
  // Match "debugger" not followed by a word character
  const kwMatch = input.match(/^debugger(?!\w)/);
  if (!kwMatch) return { success: false, rest: input };

  let rest = input.slice(kwMatch[0].length);
  const node: DebuggerStatement = { type: "debuggerStatement" };

  // Try to parse optional label
  const labelResult = debuggerLabel(rest);
  if (labelResult.success) {
    node.label = labelResult.result;
    rest = labelResult.rest;
  }

  // Consume optional semicolon
  const semiResult = optionalSemicolon(rest);
  if (semiResult.success) {
    rest = semiResult.rest;
  }

  return { success: true, result: node, rest };
};
```

Note: This uses a hand-written parser rather than tarsec combinators because `debugger` is a bare keyword (no leading keyword like `return`), and we need negative lookahead to avoid matching `debuggerFoo`. Check the existing parsers for similar patterns — if there's a `notFollowedBy` or `wordBoundary` combinator available in tarsec, use that instead. Look at how `keyword.ts` parser handles similar cases.

Use tarsec combinators where possible, but it's okay to write custom regex logic for the initial keyword match if it simplifies the negative lookahead.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/parsers/debuggerStatement.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Wire the parser into the main parser**

In `lib/parser.ts`:
- Add import: `import { debuggerParser } from "./parsers/debuggerStatement.js";`
- Add `debuggerParser` to the `or(...)` list inside `agencyNode`. Place it early, before `assignmentParser` and `valueAccessParser`, since those could match `debugger` as an identifier. A good location is near `handleBlockParser` or `returnStatementParser`.

- [ ] **Step 6: Write an integration test for parsing debugger in a program**

Add a test to the parser test or create a small test:

```typescript
import { parseAgency } from "../parser.js";

it("parses debugger in a node body", () => {
  const code = `node main() {\n  debugger\n  debugger("label")\n  return 1\n}`;
  const result = parseAgency(code);
  expect(result.success).toBe(true);
  const nodeBody = result.result.nodes[0].body;
  expect(nodeBody[0].type).toBe("debuggerStatement");
  expect(nodeBody[1].type).toBe("debuggerStatement");
  expect(nodeBody[1].label).toBe("label");
});
```

- [ ] **Step 7: Run all parser tests**

Run: `pnpm vitest run lib/parsers/`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add lib/parsers/debuggerStatement.ts lib/parsers/debuggerStatement.test.ts lib/parser.ts
git commit -m "feat: add parser for debugger keyword"
```

---

### Task 3: Config

**Files:**
- Modify: `lib/config.ts`

- [ ] **Step 1: Add debugger config option**

In `lib/config.ts`, add to the `AgencyConfig` interface:

```typescript
  /** Enable debugger mode — auto-inserts breakpoints before every step */
  debugger?: boolean;
```

- [ ] **Step 2: Commit**

```bash
git add lib/config.ts
git commit -m "feat: add debugger config option"
```

---

### Task 4: Code Generation (Builder)

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

**Key references:**
- `processNode` switch statement: line ~474-546
- `processReturnStatement` interrupt handling: line ~1491-1504
- `renderInterruptReturn` template: `lib/templates/backends/typescriptGenerator/interruptReturn.mustache`
- `processBodyAsParts`: line ~2147-2185

- [ ] **Step 1: Write a generator fixture test for bare `debugger`**

Create `tests/typescriptGenerator/debugger.agency`:

```agency
node main() {
  x = 1
  debugger
  return x
}
```

Create `tests/typescriptGenerator/debugger.mts` — leave empty for now (we'll generate the expected output).

- [ ] **Step 2: Add `debuggerStatement` case to `processNode` in the builder**

In `lib/backends/typescriptBuilder.ts`, add a case in the `processNode` switch (near the `sentinel` case):

```typescript
case "debuggerStatement":
  return this.processDebuggerStatement(node);
```

- [ ] **Step 3: Implement `processDebuggerStatement`**

Add the method to the `TypeScriptBuilder` class. It reuses the existing `renderInterruptReturn` template with a new `debugger` flag:

```typescript
private processDebuggerStatement(node: DebuggerStatement): TsNode {
  const label = node.label !== undefined
    ? `\`${node.label}\``
    : "undefined";
  return ts.raw(
    renderInterruptReturn.default({
      interruptArgs: label,
      nodeContext: this.isInsideGraphNode,
      debugger: true,
    }),
  );
}
```

Note: You'll need to import `DebuggerStatement` at the top of the file.

- [ ] **Step 3b: Update the `interruptReturn.mustache` template**

In `lib/templates/backends/typescriptGenerator/interruptReturn.mustache`, modify the `else` branch (the "no prior response" path) to handle the `debugger` flag. When `debugger` is true, skip `interruptWithHandlers()` and directly create the checkpoint with `debugger: true` set on the interrupt:

```mustache
} else {
  {{#debugger}}
  const __debugInterrupt = interrupt({{{interruptArgs}}});
  __debugInterrupt.debugger = true;
  const __checkpointId = __ctx.checkpoints.create(__ctx);
  __debugInterrupt.checkpointId = __checkpointId;
  __debugInterrupt.checkpoint = __ctx.checkpoints.get(__checkpointId);
  {{#nodeContext}}
  return { messages: __threads, data: __debugInterrupt };
  {{/nodeContext}}
  {{^nodeContext}}
  return __debugInterrupt;
  {{/nodeContext}}
  {{/debugger}}
  {{^debugger}}
  const __handlerResult = await interruptWithHandlers({{{interruptArgs}}}, __ctx);
  ... existing handler code unchanged ...
  {{/debugger}}
}
```

This diff should be as simple and easy to read as possible.

After modifying the `.mustache` file, run `pnpm run templates` to recompile it to TypeScript.

- [ ] **Step 4: Generate the expected fixture output**

Run: `pnpm run compile tests/typescriptGenerator/debugger.agency`

Copy the generated output to `tests/typescriptGenerator/debugger.mts`. Verify the output contains the debugger interrupt code with `debugger: true` and that it does NOT contain `interruptWithHandlers`.

- [ ] **Step 5: Run the generator fixture test**

Run: `pnpm vitest run tests/typescriptGenerator/`
Expected: PASS — the debugger fixture matches

- [ ] **Step 6: Add debugger mode insertion to `processBodyAsParts`**

In `lib/backends/typescriptBuilder.ts`, in `processBodyAsParts()` (line ~2147), add debugger insertion logic. The builder needs access to config — check how it's already accessed (likely `this.config`).

Before the main loop over `body`, insert debugger statements:

```typescript
private processBodyAsParts(
  body: AgencyNode[],
  opts: { isInSafeFunction?: boolean } = {},
): TsStepBlock[] {
  // Debugger mode: insert breakpoints before each step-triggering statement
  if (this.config?.debugger) {
    const expanded: AgencyNode[] = [];
    for (const stmt of body) {
      if (!TYPES_THAT_DONT_TRIGGER_NEW_PART.includes(stmt.type)) {
        expanded.push({ type: "debuggerStatement" } as DebuggerStatement);
      }
      expanded.push(stmt);
    }
    body = expanded;
  }

  // ... rest of existing code unchanged ...
```

- [ ] **Step 7: Write a generator fixture test for debugger mode**

Create `tests/typescriptGenerator/debugger-mode.agency`:

```agency
node main() {
  x = 1
  y = 2
  return x
}
```

Compile with `debugger: true` config and verify the output has debugger breakpoints before each of the 3 statements. Save as `tests/typescriptGenerator/debugger-mode.mts`.

Note: Check how other fixtures pass config to the compiler — you may need to add a config file or modify the fixture test runner.

- [ ] **Step 8: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/debugger.agency tests/typescriptGenerator/debugger.mts tests/typescriptGenerator/debugger-mode.agency tests/typescriptGenerator/debugger-mode.mts
git commit -m "feat: add debugger code generation and debugger mode insertion"
```

---

### Task 5: Formatter

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`

- [ ] **Step 1: Add `debuggerStatement` case to the formatter**

In `lib/backends/agencyGenerator.ts`, find the `processNode` switch statement and add:

```typescript
case "debuggerStatement":
  return node.label ? `debugger("${node.label}")` : "debugger";
```

- [ ] **Step 2: Test formatting**

Write a quick test or verify manually:

```bash
echo 'node main() {\n  debugger\n  debugger("label")\n}' | pnpm run fmt -
```

Or add a unit test if the formatter has a test file.

- [ ] **Step 3: Commit**

```bash
git add lib/backends/agencyGenerator.ts
git commit -m "feat: add debugger statement to formatter"
```

---

### Task 6: Type Checker

**Files:**
- Modify: `lib/typeChecker.ts`

- [ ] **Step 1: Verify `debuggerStatement` handling is needed**

The type checker in `lib/typeChecker.ts` uses if-else chains (not a switch with a default throw). It only processes types it cares about (`assignment`, `forLoop`, `ifElse`, etc.) and silently ignores others. Verify this by searching for any catch-all or error for unhandled types. If the type checker silently ignores unknown types (like it does for `sentinel` and `comment`), no changes are needed — skip to the commit step. If it does throw on unknown types, add `debuggerStatement` to whatever allowlist exists.

- [ ] **Step 2: Verify type checking passes**

Run: `pnpm run compile tests/typescriptGenerator/debugger.agency` with `typeCheck: true`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts
git commit -m "feat: add debugger statement to type checker"
```

---

### Task 7: Integration Tests — Explicit Debugger

**Files:**
- Create: `tests/agency-js/debugger/debugger-basic/agent.agency`
- Create: `tests/agency-js/debugger/debugger-basic/test.js`
- Create: `tests/agency-js/debugger/debugger-basic/fixture.json`
- Create: `tests/agency-js/debugger/debugger-overrides/agent.agency`
- Create: `tests/agency-js/debugger/debugger-overrides/test.js`
- Create: `tests/agency-js/debugger/debugger-overrides/fixture.json`

**Reference:** Follow the pattern in `tests/agency-js/rewind/rewind-overrides/`.

- [ ] **Step 1: Create basic debugger test**

`tests/agency-js/debugger/debugger-basic/agent.agency`:

```agency
node main() {
  x = 1
  debugger("before increment")
  x = x + 1
  return x
}
```

Compile: `pnpm run compile tests/agency-js/debugger/debugger-basic/agent.agency`

- [ ] **Step 2: Write the test runner**

`tests/agency-js/debugger/debugger-basic/test.js`:

```javascript
import { main, approveInterrupt, isInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

// Should be a debugger interrupt
const isDebuggerInterrupt = isInterrupt(result.data) && result.data.debugger === true;
const label = result.data.data;

// Approve and continue
const resumed = await approveInterrupt(result.data);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      isDebuggerInterrupt,
      label,
      finalResult: resumed.data,
    },
    null,
    2,
  ),
);
```

- [ ] **Step 3: Create fixture**

`tests/agency-js/debugger/debugger-basic/fixture.json`:

```json
{
  "isDebuggerInterrupt": true,
  "label": "before increment",
  "finalResult": 2
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/agency-js/debugger/debugger-basic/`
Expected: PASS

- [ ] **Step 5: Create overrides test**

`tests/agency-js/debugger/debugger-overrides/agent.agency`:

```agency
node main() {
  x = 1
  debugger
  y = x + 10
  return y
}
```

Compile it.

- [ ] **Step 6: Write the overrides test runner**

`tests/agency-js/debugger/debugger-overrides/test.js`:

```javascript
import { main, approveInterrupt, isInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

// Approve but override x to 100
const resumed = await approveInterrupt(result.data, {
  overrides: { x: 100 },
});

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalResult: resumed.data,
    },
    null,
    2,
  ),
);
```

- [ ] **Step 7: Create overrides fixture**

`tests/agency-js/debugger/debugger-overrides/fixture.json`:

```json
{
  "finalResult": 110
}
```

- [ ] **Step 8: Run the overrides test**

Run: `pnpm vitest run tests/agency-js/debugger/debugger-overrides/`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add tests/agency-js/debugger/
git commit -m "test: add integration tests for debugger keyword"
```

---

### Task 8: Integration Tests — Handler Bypass

**Files:**
- Create: `tests/agency-js/debugger/debugger-handler-bypass/agent.agency`
- Create: `tests/agency-js/debugger/debugger-handler-bypass/test.js`
- Create: `tests/agency-js/debugger/debugger-handler-bypass/fixture.json`

This test verifies that `debugger` inside a `handle` block is NOT caught by the handler.

- [ ] **Step 1: Create handler bypass test**

`tests/agency-js/debugger/debugger-handler-bypass/agent.agency`:

```agency
node main() {
  handle {
    debugger("inside handle")
    return 42
  } with (data) {
    return approve()
  }
}
```

Compile it.

- [ ] **Step 2: Write the test runner**

`tests/agency-js/debugger/debugger-handler-bypass/test.js`:

```javascript
import { main, approveInterrupt, isInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();

// The debugger should bypass the handler and reach the caller
const isDebuggerInterrupt = isInterrupt(result.data) && result.data.debugger === true;

// Approve to continue
const resumed = await approveInterrupt(result.data);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      isDebuggerInterrupt,
      finalResult: resumed.data,
    },
    null,
    2,
  ),
);
```

- [ ] **Step 3: Create fixture**

`tests/agency-js/debugger/debugger-handler-bypass/fixture.json`:

```json
{
  "isDebuggerInterrupt": true,
  "finalResult": 42
}
```

- [ ] **Step 4: Run test**

Run: `pnpm vitest run tests/agency-js/debugger/debugger-handler-bypass/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/debugger/debugger-handler-bypass/
git commit -m "test: add handler bypass test for debugger"
```

---

### Task 9: Integration Tests — Debugger Mode

**Files:**
- Create: `tests/agency-js/debugger/debugger-mode/agent.agency`
- Create: `tests/agency-js/debugger/debugger-mode/test.js`
- Create: `tests/agency-js/debugger/debugger-mode/fixture.json`

- [ ] **Step 1: Create debugger mode test**

`tests/agency-js/debugger/debugger-mode/agent.agency`:

```agency
node main() {
  x = 1
  y = 2
  return x + y
}
```

Compile with `debugger: true` in config. Check how other agency-js tests handle config — you may need an `agency.json` in the test directory, or pass config to the compile function.

- [ ] **Step 2: Write the test runner**

`tests/agency-js/debugger/debugger-mode/test.js`:

```javascript
import { main, approveInterrupt, isInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

let breakpointCount = 0;
let result = await main();

// Loop through all debugger breakpoints, approving each
while (isInterrupt(result.data) && result.data.debugger === true) {
  breakpointCount++;
  result = await approveInterrupt(result.data);
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      breakpointCount,
      finalResult: result.data,
    },
    null,
    2,
  ),
);
```

- [ ] **Step 3: Create fixture**

The program has 3 step-triggering statements (`x = 1`, `y = 2`, `return x + y`), so debugger mode should insert 3 breakpoints:

`tests/agency-js/debugger/debugger-mode/fixture.json`:

```json
{
  "breakpointCount": 3,
  "finalResult": 3
}
```

- [ ] **Step 4: Run test**

Run: `pnpm vitest run tests/agency-js/debugger/debugger-mode/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/debugger/debugger-mode/
git commit -m "test: add integration test for debugger mode"
```

---

### Task 10: Integration Tests — Multiple Debuggers and Sequences

**Files:**
- Create: `tests/agency-js/debugger/debugger-sequential/agent.agency`
- Create: `tests/agency-js/debugger/debugger-sequential/test.js`
- Create: `tests/agency-js/debugger/debugger-sequential/fixture.json`

- [ ] **Step 1: Create sequential debugger test**

`tests/agency-js/debugger/debugger-sequential/agent.agency`:

```agency
node main() {
  x = 1
  debugger("first")
  x = x + 1
  debugger("second")
  x = x + 1
  return x
}
```

Compile it.

- [ ] **Step 2: Write the test runner**

`tests/agency-js/debugger/debugger-sequential/test.js`:

```javascript
import { main, approveInterrupt, isInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

const labels = [];

let result = await main();

// First debugger
if (isInterrupt(result.data) && result.data.debugger === true) {
  labels.push(result.data.data);
  result = await approveInterrupt(result.data);
}

// Second debugger
if (isInterrupt(result.data) && result.data.debugger === true) {
  labels.push(result.data.data);
  result = await approveInterrupt(result.data);
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      labels,
      finalResult: result.data,
    },
    null,
    2,
  ),
);
```

- [ ] **Step 3: Create fixture**

`tests/agency-js/debugger/debugger-sequential/fixture.json`:

```json
{
  "labels": ["first", "second"],
  "finalResult": 3
}
```

- [ ] **Step 4: Run test**

Run: `pnpm vitest run tests/agency-js/debugger/debugger-sequential/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/debugger/debugger-sequential/
git commit -m "test: add sequential debugger test"
```

---

### Task 11: Integration Tests — Debugger in Blocks and Functions

**Files:**
- Create: `tests/agency-js/debugger/debugger-in-if/agent.agency`
- Create: `tests/agency-js/debugger/debugger-in-if/test.js`
- Create: `tests/agency-js/debugger/debugger-in-if/fixture.json`
- Create: `tests/agency-js/debugger/debugger-in-function/agent.agency`
- Create: `tests/agency-js/debugger/debugger-in-function/test.js`
- Create: `tests/agency-js/debugger/debugger-in-function/fixture.json`

These tests cover the spec requirements for debugger inside blocks and across function call stacks.

- [ ] **Step 1: Create debugger-in-if test**

`tests/agency-js/debugger/debugger-in-if/agent.agency`:

```agency
node main() {
  x = 5
  if (x > 3) {
    debugger("inside if")
    x = x + 10
  }
  return x
}
```

Compile it.

- [ ] **Step 2: Write test runner and fixture**

`tests/agency-js/debugger/debugger-in-if/test.js`:

```javascript
import { main, approveInterrupt, isInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

let result = await main();

const hitDebugger = isInterrupt(result.data) && result.data.debugger === true;
result = await approveInterrupt(result.data);

writeFileSync(
  "__result.json",
  JSON.stringify({ hitDebugger, finalResult: result.data }, null, 2),
);
```

`tests/agency-js/debugger/debugger-in-if/fixture.json`:

```json
{
  "hitDebugger": true,
  "finalResult": 15
}
```

- [ ] **Step 3: Create debugger-in-function test**

`tests/agency-js/debugger/debugger-in-function/agent.agency`:

```agency
def addTen(x: number): number {
  debugger("inside function")
  return x + 10
}

node main() {
  result = addTen(5)
  return result
}
```

Compile it.

- [ ] **Step 4: Write test runner and fixture**

`tests/agency-js/debugger/debugger-in-function/test.js`:

```javascript
import { main, approveInterrupt, isInterrupt } from "./agent.js";
import { writeFileSync } from "fs";

let result = await main();

const hitDebugger = isInterrupt(result.data) && result.data.debugger === true;
const label = result.data.data;
result = await approveInterrupt(result.data);

writeFileSync(
  "__result.json",
  JSON.stringify({ hitDebugger, label, finalResult: result.data }, null, 2),
);
```

`tests/agency-js/debugger/debugger-in-function/fixture.json`:

```json
{
  "hitDebugger": true,
  "label": "inside function",
  "finalResult": 15
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/agency-js/debugger/debugger-in-if/ tests/agency-js/debugger/debugger-in-function/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tests/agency-js/debugger/debugger-in-if/ tests/agency-js/debugger/debugger-in-function/
git commit -m "test: add debugger tests for if blocks and cross-function calls"
```

---

### Task 12: Audit Logging for Overrides

**Files:**
- Modify: `lib/runtime/audit.ts`
- Modify: `lib/runtime/interrupts.ts`
- Modify: `lib/runtime/rewind.ts`

**Reference:** Check how `ctx.audit()` is called in `lib/runtime/prompt.ts` and `lib/runtime/node.ts` for the pattern. Check `lib/runtime/audit.ts` for the `AuditEntry` union type.

- [ ] **Step 1: Add `OverrideAudit` variant to the `AuditEntry` type**

In `lib/runtime/audit.ts`, add a new variant to the `AuditEntry` discriminated union:

```typescript
export type OverrideAudit = AuditBase & {
  type: "override";
  overrides: Record<string, unknown>;
  source: "interrupt" | "rewind";
};
```

Add `| OverrideAudit` to the `AuditEntry` union.

- [ ] **Step 2: Add audit entry when overrides are applied in interrupt responses**

In `lib/runtime/interrupts.ts`, find where `applyOverrides` is called in `respondToInterrupt()`. After the `applyOverrides` call, add an audit entry:

```typescript
if (args.overrides) {
  applyOverrides(checkpoint, args.overrides);
  await ctx.audit({
    type: "override",
    overrides: args.overrides,
    source: "interrupt",
  });
}
```

- [ ] **Step 2: Add audit entry when overrides are applied in rewindFrom**

In `lib/runtime/rewind.ts`, find where `applyOverrides` is called in `rewindFrom()`. After the call, add:

```typescript
if (overrides) {
  applyOverrides(checkpoint, overrides);
  await ctx.audit({
    type: "override",
    overrides,
    source: "rewind",
  });
}
```

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `pnpm vitest run tests/agency-js/rewind/`
Expected: All existing rewind tests still PASS

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/audit.ts lib/runtime/interrupts.ts lib/runtime/rewind.ts
git commit -m "feat: add audit logging for interrupt and rewind overrides"
```

---

### Task 13: Regenerate Fixtures and Final Verification

- [ ] **Step 1: Rebuild templates (if any mustache files were changed)**

Run: `pnpm run templates`

- [ ] **Step 2: Build the project**

Run: `pnpm run build`
Expected: No compilation errors

- [ ] **Step 3: Regenerate all test fixtures**

Run: `make fixtures`
Expected: Fixtures regenerate successfully

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test:run`
Expected: All tests PASS

- [ ] **Step 5: Final commit if fixtures changed**

```bash
git add -A tests/
git commit -m "chore: regenerate test fixtures for debugger feature"
```
