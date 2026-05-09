# Serve System Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add language features and runtime support needed by the unified serve system: `export node`, `export const`, `exported`/`safe` metadata on AgencyFunction, and a shared logger with log levels.

**Architecture:** Small, independent changes to the parser, AST types, builder, and runtime. Each task is self-contained and can be committed independently.

**Tech Stack:** TypeScript, tarsec parser combinators, existing Agency compiler pipeline.

**Spec:** `docs/superpowers/specs/2026-05-07-unified-serve-and-http-transport-design.md`

---

## File Structure

### Modified files
| File | Change |
|---|---|
| `lib/types/graphNode.ts:21-32` | Add `exported?: boolean` to `GraphNodeDefinition` |
| `lib/types.ts:157-166` | Add `exported?: boolean` to `Assignment` |
| `lib/parsers/parsers.ts:2712-2715, 2802-2847, 2154-2235` | Add `export` keyword support to node and assignment parsers |
| `lib/parsers/function.test.ts` | Add tests for existing export behavior (reference) |
| `lib/backends/typescriptBuilder.ts:1889-1905, 2328-2443` | Pass `exported`/`safe` to AgencyFunction.create(); handle `export` for nodes and assignments |
| `lib/runtime/agencyFunction.ts:25-55, 70-78, 98-141` | Add `exported`/`safe` fields; propagate through `partial()`, `withToolDefinition()` |
| `lib/backends/agencyGenerator.ts:443-462, 904-916` | Add `export` prefix for nodes and const assignments in formatter |
| `lib/config.ts:28` | Replace `verbose?: boolean` with `logLevel?: string` |

### New files
| File | Responsibility |
|---|---|
| `lib/parsers/exportNode.test.ts` | Tests for `export node` parsing |
| `lib/parsers/exportConst.test.ts` | Tests for `export const` parsing |
| `lib/logger.ts` | Shared logger with configurable log levels |
| `lib/logger.test.ts` | Tests for logger |

---

## Task 1: Add `exported` and `safe` fields to AgencyFunction

**Files:**
- Modify: `lib/runtime/agencyFunction.ts:25-55, 70-78, 98-141`

- [ ] **Step 1: Add fields to AgencyFunctionOpts type (lines 25-31)**

```typescript
export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: Function;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
  exported?: boolean;
  safe?: boolean;
};
```

- [ ] **Step 2: Add class fields and constructor assignments**

Add after line 43 (class fields):
```typescript
readonly exported: boolean;
readonly safe: boolean;
```

Add after line 50 (in constructor):
```typescript
this.exported = opts.exported ?? false;
this.safe = opts.safe ?? false;
```

- [ ] **Step 3: Propagate through `withToolDefinition()` (lines 70-78)**

Add `exported: this.exported, safe: this.safe` to the opts object passed to `new AgencyFunction(...)`.

- [ ] **Step 4: Propagate through `partial()` (lines 135-141)**

Add `exported: this.exported, safe: this.safe` to the opts object passed to `new AgencyFunction(...)`.

- [ ] **Step 5: Run existing tests**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/prereq-task1.txt && cat /tmp/claude/prereq-task1.txt`

Expected: All tests pass (new fields are optional with defaults).

- [ ] **Step 6: Commit**

```
git add lib/runtime/agencyFunction.ts
git commit -m "Add exported and safe fields to AgencyFunction"
```

---

## Task 2: Pass `exported` and `safe` through code generation for functions

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1889-1905`

- [ ] **Step 1: Add `safe` and `exported` to AgencyFunction.create() in processFunction**

Find the `ts.obj` call around line 1889. Add both fields:

```typescript
ts.obj({
  name: ts.str(functionName),
  module: ts.str(this.moduleId),
  fn: ts.id(implName),
  params: ts.arr(paramNodes),
  toolDefinition: toolDef,
  safe: ts.bool(!!this.compilationUnit.safeFunctions[functionName]),
  exported: ts.bool(!!node.exported),
}),
```

`node.exported` is already on `FunctionDefinition` (`lib/types/function.ts:53`). `safeFunctions` is in `compilationUnit.ts:89`.

- [ ] **Step 2: Run existing tests**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/prereq-task2.txt && cat /tmp/claude/prereq-task2.txt`

Expected: All tests pass.

- [ ] **Step 3: Rebuild fixtures to verify generated output**

Run: `make fixtures 2>&1 | tail -10 > /tmp/claude/prereq-task2-fixtures.txt && cat /tmp/claude/prereq-task2-fixtures.txt`

Check a fixture with `export def` to verify the compiled output now includes `safe: false, exported: true` in the `AgencyFunction.create()` call.

- [ ] **Step 4: Commit**

```
git add lib/backends/typescriptBuilder.ts
git commit -m "Pass exported and safe flags to AgencyFunction.create() for functions"
```

---

## Task 3: Add `export node` support to the parser

**Files:**
- Modify: `lib/types/graphNode.ts:21-32`
- Modify: `lib/parsers/parsers.ts:2802-2847`
- Create: `lib/parsers/exportNode.test.ts`

Currently, nodes use `visibility` (`public`/`private`). We want to add `export` support so nodes work the same way as functions for the serve system.

- [ ] **Step 1: Add `exported` to GraphNodeDefinition type**

In `lib/types/graphNode.ts`, add `exported?: boolean` to the type (after line 28):

```typescript
export type GraphNodeDefinition = BaseNode & {
  type: "graphNode";
  nodeName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  visibility?: Visibility;
  exported?: boolean;
  tags?: Tag[];
  docComment?: AgencyMultiLineComment;
  docString?: DocString;
};
```

- [ ] **Step 2: Write parser tests**

Create `lib/parsers/exportNode.test.ts`. Look at the existing function export tests in `lib/parsers/function.test.ts:2057-2096` for the pattern:

```typescript
import { describe, expect, it } from "vitest";
import { graphNodeParser } from "./parsers.js";
import { testParse } from "./testUtil.js";

describe("export node", () => {
  it("parses export node", () => {
    const result = testParse(graphNodeParser, `export node main() {\n  print("hello")\n}`);
    expect(result.exported).toBe(true);
    expect(result.nodeName).toBe("main");
  });

  it("parses node without export", () => {
    const result = testParse(graphNodeParser, `node main() {\n  print("hello")\n}`);
    expect(result.exported).toBeUndefined();
  });

  it("parses export with visibility", () => {
    const result = testParse(graphNodeParser, `export public node main() {\n  print("hello")\n}`);
    expect(result.exported).toBe(true);
    expect(result.visibility).toBe("public");
  });
});
```

Note: Check `testParse` or equivalent test helpers used in `lib/parsers/function.test.ts` and use the same pattern. The parser file and test utility imports may need adjustment.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run lib/parsers/exportNode.test.ts 2>&1 > /tmp/claude/prereq-task3-fail.txt && cat /tmp/claude/prereq-task3-fail.txt`

Expected: FAIL — `exported` is undefined because the parser doesn't set it yet.

- [ ] **Step 4: Add export keyword to the node parser**

In `lib/parsers/parsers.ts`, the `graphNodeParser` is at lines 2802-2847. The `exportKeywordParser` already exists at lines 2712-2715 and is used by the function parser. Add it to the node parser too.

Look at how the function parser (`_functionParserInner`, lines 2722-2760) uses `exportKeywordParser` — it's called at the beginning of the parser sequence, and if it succeeds, `result.exported = true` is set. Apply the same pattern to `graphNodeParser`.

The export keyword should come before any visibility modifier: `export public node main()`.

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/parsers/exportNode.test.ts 2>&1 > /tmp/claude/prereq-task3-pass.txt && cat /tmp/claude/prereq-task3-pass.txt`

Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/prereq-task3-full.txt && cat /tmp/claude/prereq-task3-full.txt`

Expected: All existing tests still pass.

- [ ] **Step 7: Commit**

```
git add lib/types/graphNode.ts lib/parsers/parsers.ts lib/parsers/exportNode.test.ts
git commit -m "Add export keyword support to node parser"
```

---

## Task 4: Handle `export node` in code generation and formatting

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:2328-2443`
- Modify: `lib/backends/agencyGenerator.ts:904-916`

- [ ] **Step 1: Research how nodes are currently exported in the builder**

Read `lib/backends/typescriptBuilder.ts` around the `processGraphNode` method (lines 2328-2443) and find where the compiled node function is marked as exported. Search for `export: true` in the node-related code generation.

- [ ] **Step 2: Make node export conditional in the builder**

The `exported` flag controls serve visibility. However, the compiled TypeScript should always export nodes (for backward compatibility with existing TypeScript consumers who import nodes). The serve system reads the `exported` flag from the compilation unit to decide what to expose as endpoints.

This means the builder doesn't need to change the TypeScript export behavior — it already exports all nodes. Instead, the `exported` flag needs to be tracked somewhere the serve system can read it. Store it in the compilation unit alongside `safeFunctions`, e.g., as `exportedNodes: Record<string, boolean>`. The serve system will check this when discovering what to serve.

- [ ] **Step 3: Add `export` prefix to the Agency generator**

In `lib/backends/agencyGenerator.ts`, the `processGraphNode` method (line 904) already handles visibility. Add `export` prefix handling so that `export node` roundtrips correctly through format:

At line 911-912, change:
```typescript
const visibilityStr = this.visibilityToString(node.visibility);
const prefix = `${visibilityStr}node ${nodeName}`;
```
to:
```typescript
const exportPrefix = node.exported ? "export " : "";
const visibilityStr = this.visibilityToString(node.visibility);
const prefix = `${exportPrefix}${visibilityStr}node ${nodeName}`;
```

- [ ] **Step 4: Run existing tests**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/prereq-task4.txt && cat /tmp/claude/prereq-task4.txt`

Expected: All tests pass.

- [ ] **Step 5: Test roundtrip formatting**

Write a small `.agency` file with `export node main() { print("hello") }`, run it through `pnpm run fmt`, and verify the `export` keyword is preserved.

- [ ] **Step 6: Commit**

```
git add lib/backends/typescriptBuilder.ts lib/backends/agencyGenerator.ts
git commit -m "Handle export node in code generation and formatting"
```

---

## Task 5: Add `export const` support to the parser

**Files:**
- Modify: `lib/types.ts:157-166`
- Modify: `lib/parsers/parsers.ts:2154-2235`
- Create: `lib/parsers/exportConst.test.ts`

Add `export` keyword support for `const` assignments. `export let` is NOT allowed — only `const`.

- [ ] **Step 1: Add `exported` to Assignment type**

In `lib/types.ts`, add `exported?: boolean` to the `Assignment` type (after line 165):

```typescript
export type Assignment = BaseNode & {
  type: "assignment";
  variableName: string;
  accessChain?: AccessChainElement[];
  typeHint?: VariableType;
  validated?: boolean;
  scope?: ScopeType;
  static?: boolean;
  declKind?: "let" | "const";
  value: Expression | MessageThread;
  tags?: Tag[];
  exported?: boolean;
};
```

- [ ] **Step 2: Write parser tests**

Create `lib/parsers/exportConst.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { assignmentParser } from "./parsers.js";
import { testParse } from "./testUtil.js";

describe("export const", () => {
  it("parses export const", () => {
    const result = testParse(assignmentParser, `export const x = 5`);
    expect(result.exported).toBe(true);
    expect(result.declKind).toBe("const");
    expect(result.variableName).toBe("x");
  });

  it("does not allow export let", () => {
    expect(() => testParse(assignmentParser, `export let x = 5`)).toThrow();
  });

  it("parses const without export", () => {
    const result = testParse(assignmentParser, `const x = 5`);
    expect(result.exported).toBeUndefined();
  });
});
```

Note: Verify the correct parser name and test utility imports. Check existing assignment tests for the pattern.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run lib/parsers/exportConst.test.ts 2>&1 > /tmp/claude/prereq-task5-fail.txt && cat /tmp/claude/prereq-task5-fail.txt`

Expected: FAIL.

- [ ] **Step 4: Add export keyword to the assignment parser**

In `lib/parsers/parsers.ts`, the assignment parser is at lines 2154-2235. Add the `exportKeywordParser` at the beginning of the sequence, same pattern as functions. If `export` is present and `declKind` is not `"const"`, throw an error: "Only const declarations can be exported".

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/parsers/exportConst.test.ts 2>&1 > /tmp/claude/prereq-task5-pass.txt && cat /tmp/claude/prereq-task5-pass.txt`

Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/prereq-task5-full.txt && cat /tmp/claude/prereq-task5-full.txt`

Expected: All existing tests still pass.

- [ ] **Step 7: Commit**

```
git add lib/types.ts lib/parsers/parsers.ts lib/parsers/exportConst.test.ts
git commit -m "Add export const support to parser"
```

---

## Task 6: Handle `export const` in code generation and formatting

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`
- Modify: `lib/backends/agencyGenerator.ts:443-462`

- [ ] **Step 1: Research how assignments are currently compiled**

Read how the builder processes `Assignment` nodes. Search for `processAssignment` or `assignment` handling in `typescriptBuilder.ts`. Understand what code is generated for `const x = someValue`.

- [ ] **Step 2: Add export handling for const assignments in the builder**

When `node.exported` is true on an Assignment, the compiled TypeScript should have `export` on the generated `const` declaration. This is the same pattern used for functions (line 1905): `node.exported ? ts.export(constDecl) : constDecl`.

- [ ] **Step 3: Add `export` prefix to the Agency generator**

In `lib/backends/agencyGenerator.ts`, the `processAssignment` method (line 443) already handles `static` and `declKind` prefixes. Add `export` prefix handling at line 453-461:

Change:
```typescript
const staticPrefix = node.static ? "static " : "";
const declPrefix = node.declKind ? `${node.declKind} ` : "";
```
to:
```typescript
const exportPrefix = node.exported ? "export " : "";
const staticPrefix = node.static ? "static " : "";
const declPrefix = node.declKind ? `${node.declKind} ` : "";
```

And update the template string at line 461 to include `${exportPrefix}`.

- [ ] **Step 4: Run existing tests**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/prereq-task6.txt && cat /tmp/claude/prereq-task6.txt`

Expected: All tests pass.

- [ ] **Step 5: Test roundtrip formatting**

Write a small `.agency` file with `export const x = 5`, run it through `pnpm run fmt`, and verify the `export` keyword is preserved.

- [ ] **Step 6: Commit**

```
git add lib/backends/typescriptBuilder.ts lib/backends/agencyGenerator.ts
git commit -m "Handle export const in code generation and formatting"
```

---

## Task 7: Add shared logger with log levels

**Files:**
- Modify: `lib/config.ts:28`
- Create: `lib/logger.ts`
- Create: `lib/logger.test.ts`

Replace `verbose?: boolean` with `logLevel` and create a shared logger.

- [ ] **Step 1: Write logger tests**

Create `lib/logger.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  let spy: any;
  beforeEach(() => {
    spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("logs at info level by default", () => {
    const log = createLogger("info");
    log.info("hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as string)).toContain("hello");
  });

  it("suppresses debug when level is info", () => {
    const log = createLogger("info");
    log.debug("hidden");
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows debug when level is debug", () => {
    const log = createLogger("debug");
    log.debug("visible");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("shows warnings at warn level", () => {
    const log = createLogger("warn");
    log.warn("caution");
    expect(spy).toHaveBeenCalledTimes(1);
    log.info("suppressed");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("error always shows", () => {
    const log = createLogger("error");
    log.error("bad");
    expect(spy).toHaveBeenCalledTimes(1);
    log.warn("suppressed");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  afterEach(() => spy.mockRestore());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/logger.test.ts 2>&1 > /tmp/claude/prereq-task7-fail.txt && cat /tmp/claude/prereq-task7-fail.txt`

- [ ] **Step 3: Implement logger**

Create `lib/logger.ts`:

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type Logger = {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVEL_ORDER[level];

  function log(msgLevel: LogLevel, message: string): void {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    process.stderr.write(`[${timestamp}] ${msgLevel.toUpperCase()} ${message}\n`);
  }

  return {
    debug: (msg) => log("debug", msg),
    info: (msg) => log("info", msg),
    warn: (msg) => log("warn", msg),
    error: (msg) => log("error", msg),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/logger.test.ts 2>&1 > /tmp/claude/prereq-task7-pass.txt && cat /tmp/claude/prereq-task7-pass.txt`

Expected: All tests pass.

- [ ] **Step 5: Add `logLevel` to AgencyConfig**

In `lib/config.ts`, replace `verbose?: boolean` with `logLevel`:

```typescript
logLevel?: "debug" | "info" | "warn" | "error";
```

Update the Zod schema to match. Keep backward compatibility: if `verbose` is set to `true` in an existing config, treat it as `logLevel: "debug"`.

- [ ] **Step 6: Update verbose usage sites**

Search for `config.verbose` across the codebase. For each usage:
- If it's checking `config.verbose` to decide whether to log, replace with a logger call at the appropriate level
- The RuntimeContext `verbose` property should be replaced with or mapped from `logLevel`

Key files to update:
- `lib/cli/commands.ts:73`
- `lib/backends/typescriptBuilder.ts:3436-3437`
- `lib/symbolTable.ts:96, 105`
- `lib/runtime/state/context.ts:92`

- [ ] **Step 7: Run full test suite**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/prereq-task7-full.txt && cat /tmp/claude/prereq-task7-full.txt`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```
git add lib/logger.ts lib/logger.test.ts lib/config.ts
git add -u  # any updated verbose usage sites
git commit -m "Add shared logger with log levels, replace verbose config"
```
