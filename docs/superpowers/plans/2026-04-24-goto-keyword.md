# `goto` Keyword Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `goto` keyword for node-to-node transitions, replacing the overloaded `return nodeCall()` pattern.

**Architecture:** New `GotoStatement` AST node, parser, builder case, and type checker validation. The generated code is identical to the existing `return nodeCall()` path — both produce `goToNode()` calls. `return nodeCall()` stays as a backward-compatible alias.

**Tech Stack:** TypeScript, Tarsec (parser combinators), Vitest

**Spec:** `docs/superpowers/specs/2026-04-24-goto-keyword-design.md`

---

### Task 1: Add GotoStatement AST type

**Files:**
- Create: `lib/types/gotoStatement.ts`
- Modify: `lib/types.ts`

- [ ] **Step 1: Create the type file**

Create `lib/types/gotoStatement.ts`:

```typescript
import { BaseNode } from "./base.js";
import { FunctionCall } from "./function.js";

export type GotoStatement = BaseNode & {
  type: "gotoStatement";
  nodeCall: FunctionCall;
};
```

- [ ] **Step 2: Add to AgencyNode union**

In `lib/types.ts`, add the import:

```typescript
import { GotoStatement } from "./types/gotoStatement.js";
```

Add `| GotoStatement` to the `AgencyNode` union type (after `| ReturnStatement`).

- [ ] **Step 3: Run tests to verify no breakage**

Run: `pnpm test:run`

Expected: All tests pass (no behavioral change yet).

- [ ] **Step 4: Commit**

```bash
git add lib/types/gotoStatement.ts lib/types.ts
git commit -m "feat: add GotoStatement AST type"
```

---

### Task 2: Add goto parser

**Files:**
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/parser.ts`
- Create: `lib/parsers/gotoStatement.test.ts`

- [ ] **Step 1: Write parser tests**

Create `lib/parsers/gotoStatement.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { gotoStatementParser } from "./parsers.js";

describe("gotoStatementParser", () => {
  it("should parse goto with a function call", () => {
    const result = gotoStatementParser("goto foo()");
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      type: "gotoStatement",
      nodeCall: {
        type: "functionCall",
        functionName: "foo",
        arguments: [],
      },
    });
  });

  it("should parse goto with arguments", () => {
    const result = gotoStatementParser("goto categorize(msg, 42)");
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      type: "gotoStatement",
      nodeCall: {
        type: "functionCall",
        functionName: "categorize",
      },
    });
    expect(result.result.nodeCall.arguments).toHaveLength(2);
  });

  it("should parse goto with optional semicolon", () => {
    const result = gotoStatementParser("goto foo();");
    expect(result.success).toBe(true);
    expect(result.result.type).toBe("gotoStatement");
  });

  it("should fail on goto without a function call", () => {
    const result = gotoStatementParser("goto 5");
    expect(result.success).toBe(false);
  });

  it("should fail on goto with just a variable name", () => {
    const result = gotoStatementParser("goto myVar");
    expect(result.success).toBe(false);
  });

  it("should fail on bare goto", () => {
    const result = gotoStatementParser("goto");
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/parsers/gotoStatement.test.ts`

Expected: FAIL — `gotoStatementParser` doesn't exist yet.

- [ ] **Step 3: Implement the parser**

In `lib/parsers/parsers.ts`, add the parser near `returnStatementParser` (around line 1604):

```typescript
export const gotoStatementParser: Parser<GotoStatement> = label("a goto statement", withLoc(seqC(
  set("type", "gotoStatement"),
  str("goto"),
  not(varNameChar),
  optionalSpaces,
  capture(functionCallParser, "nodeCall"),
  optionalSpaces,
  optionalSemicolon,
  optionalSpacesOrNewline,
)));
```

Add the `GotoStatement` import at the top of `parsers.ts`:

```typescript
import { GotoStatement } from "../types/gotoStatement.js";
```

- [ ] **Step 4: Wire into body parser**

In `lib/parsers/parsers.ts`, add `gotoStatementParser` to the `bodyParser` alternatives list (around line 1997), right after `returnStatementParser`:

```typescript
    returnStatementParser,
    gotoStatementParser,  // add this line
    forLoopParser,
```

- [ ] **Step 5: Export from parsers.ts and import in parser.ts**

Add `gotoStatementParser` to the exports if not already auto-exported.

In `lib/parser.ts`, add `gotoStatementParser` to the import from `./parsers/parsers.js` and to the array passed to `or()` in the main parser (follow the pattern of `returnStatementParser`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test:run -- lib/parsers/gotoStatement.test.ts`

Expected: All 6 tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/gotoStatement.test.ts lib/parser.ts
git commit -m "feat: add goto statement parser"
```

---

### Task 3: Add gotoStatement to walkNodes and agencyGenerator

**Files:**
- Modify: `lib/utils/node.ts`
- Modify: `lib/backends/agencyGenerator.ts`

- [ ] **Step 1: Add gotoStatement case to walkNodes**

In `lib/utils/node.ts`, after the `returnStatement` case (around line 313), add:

```typescript
    } else if (node.type === "gotoStatement") {
      yield* walkNodes([node.nodeCall], [...ancestors, node], scopes);
    }
```

- [ ] **Step 2: Add gotoStatement case to getAllVariablesInBody**

In `lib/utils/node.ts`, after the `returnStatement` case (around line 219), add:

```typescript
    } else if (node.type === "gotoStatement") {
      yield* getAllVariablesInBody([node.nodeCall]);
    }
```

- [ ] **Step 3: Add gotoStatement case to agencyGenerator**

In `lib/backends/agencyGenerator.ts`, after the `returnStatement` case (around line 216), add:

```typescript
      case "gotoStatement":
        return this.processGotoStatement(node);
```

And add the method:

```typescript
  protected processGotoStatement(node: GotoStatement): string {
    const callCode = this.processNode(node.nodeCall).trim();
    return this.indentStr(`goto ${callCode}`);
  }
```

Add the import for `GotoStatement` at the top.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/utils/node.ts lib/backends/agencyGenerator.ts
git commit -m "feat: add gotoStatement to walkNodes and agencyGenerator"
```

---

### Task 4: Add builder support for goto

Note: the preprocessor does not need a `gotoStatement` case. Its `walkBody` function handles `returnStatement` only for LLM call detection, and `goto` always targets a node call, never an LLM call.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

- [ ] **Step 1: Add case to processNode switch**

In `lib/backends/typescriptBuilder.ts`, add a case in the `processNode` switch (after the `returnStatement` case around line 758):

```typescript
      case "gotoStatement":
        return this.processGotoStatement(node);
```

- [ ] **Step 2: Add processGotoStatement method**

Add the method near `processReturnStatement`:

```typescript
  private processGotoStatement(node: GotoStatement): TsNode {
    this.currentAdjacentNodes.push(node.nodeCall.functionName);
    this.functionsUsed.add(node.nodeCall.functionName);
    return this.generateNodeCallExpression(node.nodeCall);
  }
```

Add the import at the top of the file:

```typescript
import { GotoStatement } from "../types/gotoStatement.js";
```

- [ ] **Step 3: Update the bare node call error message**

In `processGraphNode` (around line 2183), update the error message to mention `goto`:

```typescript
// Before
`Call to graph node '${stmt.functionName}' inside graph node '${nodeName}' was not returned. All calls to graph nodes must be returned, eg (return ${stmt.functionName}(...)).`

// After
`Call to graph node '${stmt.functionName}' inside graph node '${nodeName}' must use goto or return, eg: goto ${stmt.functionName}(...)`
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "feat: add builder support for goto statement"
```

---

### Task 5: Add generator fixture tests

**Files:**
- Create: `tests/typescriptGenerator/goto.agency`
- Create: `tests/typescriptGenerator/gotoWithArgs.agency`

- [ ] **Step 1: Create basic goto fixture**

Create `tests/typescriptGenerator/goto.agency`:

```
node foo() {
  print("in foo")
}

node main() {
  goto foo()
}
```

- [ ] **Step 2: Create goto-with-args fixture**

Create `tests/typescriptGenerator/gotoWithArgs.agency`:

```
node greet(name: string) {
  print("hello " + name)
}

node main() {
  goto greet("world")
}
```

- [ ] **Step 3: Generate expected output**

Run: `make fixtures`

- [ ] **Step 4: Verify the output matches return nodeCall() behavior**

Check that the generated `.mjs` files contain `goToNode("foo", ...)` — the same output as if `return foo()` had been written.

- [ ] **Step 5: Run tests**

Run: `pnpm test:run`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/typescriptGenerator/goto.agency tests/typescriptGenerator/goto.mjs tests/typescriptGenerator/gotoWithArgs.agency tests/typescriptGenerator/gotoWithArgs.mjs
git commit -m "test: add generator fixtures for goto statement"
```

---

### Task 6: Add agency execution test

**Files:**
- Create: `tests/agency/goto.agency`

- [ ] **Step 1: Create execution test**

Create `tests/agency/goto.agency`:

```
node second() {
  return "arrived at second"
}

node testGoto() {
  goto second()
}
```

- [ ] **Step 2: Compile and verify**

Run: `pnpm run compile tests/agency/goto.agency`

Verify the compiled `.js` contains `goToNode("second", ...)`.

- [ ] **Step 3: Create test fixture**

Run: `pnpm run agency fixtures tests/agency/goto.agency:testGoto`

Expected output: `"arrived at second"`. Accept with exact match.

- [ ] **Step 4: Run the test**

Run: `pnpm run agency test tests/agency/goto.test.json`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/goto.agency tests/agency/goto.test.json tests/agency/goto.js
git commit -m "test: add agency execution test for goto"
```
