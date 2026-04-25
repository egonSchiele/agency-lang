# Inline Block Syntax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `\x -> expr` inline block syntax for terse one-liner blocks inside function call parentheses.

**Architecture:** The inline block parser produces the same `BlockArgument` AST node as the existing `as` trailing blocks, with a new `inline: boolean` field. The parser post-processes function call arguments to move inline blocks to `FunctionCall.block`. No builder/runtime changes needed.

**Tech Stack:** TypeScript, tarsec parser combinators, vitest

**Spec:** `docs/superpowers/specs/2026-04-24-inline-block-syntax-design.md`

---

### Task 1: Add `inline` field to `BlockArgument` AST node

**Files:**
- Modify: `lib/types/blockArgument.ts`
- Modify: `lib/parsers/parsers.ts` (existing `blockArgumentParser`, around line 1684)

- [ ] **Step 1: Add `inline` field to `BlockArgument` type**

In `lib/types/blockArgument.ts`, add `inline?: boolean` to the type:

```typescript
export type BlockArgument = BaseNode & {
  type: "blockArgument";
  params: FunctionParameter[];
  body: AgencyNode[];
  inline?: boolean;
};
```

- [ ] **Step 2: Set `inline: false` in existing `blockArgumentParser`**

In `lib/parsers/parsers.ts`, add `set("inline", false)` to the existing `blockArgumentParser` (around line 1687), right after the `set("type", "blockArgument")` line:

```typescript
export const blockArgumentParser: Parser<BlockArgument> = trace(
  "blockArgumentParser",
  seqC(
    set("type", "blockArgument"),
    set("inline", false),
    str("as"),
    spaces,
    capture(blockParamsParser, "params"),
    optionalSpaces,
    char("{"),
    optionalSpacesOrNewline,
    capture(lazy(() => bodyParser), "body"),
    optionalSpacesOrNewline,
    char("}"),
  ),
);
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `pnpm test:run -- --reporter=verbose lib/parsers/blockArgument.test.ts`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/types/blockArgument.ts lib/parsers/parsers.ts
git commit -m "Add inline field to BlockArgument AST node"
```

---

### Task 2: Write the `inlineBlockParser`

**Files:**
- Modify: `lib/parsers/parsers.ts` (add new parser after `blockArgumentParser`, around line 1699)
- Test: `lib/parsers/blockArgument.test.ts`

The inline block parser parses `\ [params] -> expression`. It reuses the existing `blockParamParser` and `blockParamsParser` for parameter parsing. The expression body is wrapped in a synthetic `ReturnStatement` node.

- [ ] **Step 1: Write failing tests for `inlineBlockParser`**

Add these tests to `lib/parsers/blockArgument.test.ts`. You'll need to import `inlineBlockParser` from `./parsers.js` (it doesn't exist yet, so the import will fail).

```typescript
import { inlineBlockParser } from "./parsers.js";

describe("inlineBlockParser", () => {
  it("parses single param with expression body", () => {
    const input = String.raw`\x -> x + 1`;
    const result = inlineBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("blockArgument");
      expect(result.result.inline).toBe(true);
      expect(result.result.params).toHaveLength(1);
      expect(result.result.params[0].name).toBe("x");
      // Body should be a single return statement wrapping the expression
      expect(result.result.body).toHaveLength(1);
      expect(result.result.body[0].type).toBe("returnStatement");
    }
  });

  it("parses multi param with expression body", () => {
    const input = String.raw`\(x, i) -> x + i`;
    const result = inlineBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.inline).toBe(true);
      expect(result.result.params).toHaveLength(2);
      expect(result.result.params[0].name).toBe("x");
      expect(result.result.params[1].name).toBe("i");
      expect(result.result.body).toHaveLength(1);
      expect(result.result.body[0].type).toBe("returnStatement");
    }
  });

  it("parses no params with expression body", () => {
    const input = String.raw`\ -> "hello"`;
    const result = inlineBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.inline).toBe(true);
      expect(result.result.params).toHaveLength(0);
      expect(result.result.body).toHaveLength(1);
      expect(result.result.body[0].type).toBe("returnStatement");
    }
  });

  it("stops expression body at comma", () => {
    const input = String.raw`\x -> x + 1, 42`;
    const result = inlineBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.body).toHaveLength(1);
      // The rest should contain ", 42"
      expect(result.rest.trim()).toBe(", 42");
    }
  });

  it("stops expression body at closing paren", () => {
    const input = String.raw`\x -> x + 1)`;
    const result = inlineBlockParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.body).toHaveLength(1);
      expect(result.rest).toBe(")");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- --reporter=verbose lib/parsers/blockArgument.test.ts`
Expected: FAIL — `inlineBlockParser` is not exported from `./parsers.js`.

- [ ] **Step 3: Implement `inlineBlockParser`**

Add this parser to `lib/parsers/parsers.ts`, right after the existing `blockArgumentParser` (after line 1698). The parser:
1. Matches `\`
2. Parses params using the existing `blockParamsParser` (handles single, multi, and no params)
3. Matches `->` with optional surrounding spaces
4. Parses a single expression using `exprParser`
5. Wraps the expression in a synthetic `ReturnStatement` node
6. Returns a `BlockArgument` with `inline: true`

```typescript
// Parse an inline block argument: \params -> expression
//   \x -> x + 1           — single param
//   \(x, i) -> x + i      — multiple params
//   \ -> "hello"           — no params
// Expression-only: the expression is wrapped in a synthetic return statement.
export const inlineBlockParser: Parser<BlockArgument> = trace(
  "inlineBlockParser",
  (input: string): ParserResult<BlockArgument> => {
    const parser = seqC(
      set("type", "blockArgument"),
      set("inline", true),
      char("\\"),
      optionalSpaces,
      capture(blockParamsParser, "params"),
      optionalSpaces,
      str("->"),
      optionalSpaces,
      capture(lazy(() => exprParser), "__expr"),
    );
    const result = parser(input);
    if (!result.success) return result;

    // Wrap the expression in a synthetic return statement
    const expr = result.result.__expr;
    const returnNode: ReturnStatement = { type: "returnStatement", value: expr };
    return success({
      type: "blockArgument",
      inline: true,
      params: result.result.params,
      body: [returnNode],
    } as BlockArgument, result.rest);
  },
);
```

You will also need to import `ReturnStatement` at the top of `parsers.ts`. Check whether it's already imported — it likely is since `returnStatement` is parsed elsewhere. If not, add:

```typescript
import { ReturnStatement } from "../types/returnStatement.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- --reporter=verbose lib/parsers/blockArgument.test.ts`
Expected: All tests pass including the new `inlineBlockParser` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/blockArgument.test.ts
git commit -m "Add inlineBlockParser for backslash-arrow block syntax"
```

---

### Task 3: Wire inline blocks into function call parser

**Files:**
- Modify: `lib/parsers/parsers.ts` (`_functionCallParser`, around line 1135)
- Test: `lib/parsers/blockArgument.test.ts`

- [ ] **Step 1: Write failing tests for function calls with inline blocks**

Add these tests to the existing `"function call with block argument"` describe block in `lib/parsers/blockArgument.test.ts`:

```typescript
  it("parses function call with inline block as last arg", () => {
    const input = String.raw`map(arr, \x -> x + 1)`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.functionName).toBe("map");
      expect(result.result.arguments).toHaveLength(1); // just 'arr'
      expect(result.result.block).toBeDefined();
      expect(result.result.block!.inline).toBe(true);
      expect(result.result.block!.params).toHaveLength(1);
      expect(result.result.block!.params[0].name).toBe("x");
    }
  });

  it("parses function call with inline block and multiple regular args", () => {
    const input = String.raw`foo(1, "bar", \x -> x + 1)`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.functionName).toBe("foo");
      expect(result.result.arguments).toHaveLength(2); // 1 and "bar"
      expect(result.result.block).toBeDefined();
      expect(result.result.block!.inline).toBe(true);
    }
  });

  it("parses function call with inline block as non-last arg", () => {
    const input = String.raw`foo(\x -> x + 1, 42)`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.functionName).toBe("foo");
      expect(result.result.arguments).toHaveLength(1); // just 42
      expect(result.result.block).toBeDefined();
      expect(result.result.block!.inline).toBe(true);
    }
  });

  it("parses function call with multi-param inline block", () => {
    const input = String.raw`mapWithIndex(arr, \(x, i) -> x + i)`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.arguments).toHaveLength(1); // just 'arr'
      expect(result.result.block).toBeDefined();
      expect(result.result.block!.params).toHaveLength(2);
      expect(result.result.block!.params[0].name).toBe("x");
      expect(result.result.block!.params[1].name).toBe("i");
    }
  });

  it("parses function call with no-param inline block", () => {
    const input = String.raw`sample(5, \ -> "hello")`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.arguments).toHaveLength(1); // just 5
      expect(result.result.block).toBeDefined();
      expect(result.result.block!.params).toHaveLength(0);
    }
  });

  it("parses nested inline blocks in nested function calls", () => {
    const input = String.raw`map(arr, \x -> filter(x, \y -> y > 0))`;
    const result = functionCallParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.functionName).toBe("map");
      expect(result.result.block).toBeDefined();
      // The body of the outer block is a return statement containing the inner function call
      const returnStmt = result.result.block!.body[0];
      expect(returnStmt.type).toBe("returnStatement");
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- --reporter=verbose lib/parsers/blockArgument.test.ts`
Expected: FAIL — inline blocks are not yet recognized inside function call arguments.

- [ ] **Step 3: Wire `inlineBlockParser` into `_functionCallParser`**

Modify `_functionCallParser` in `lib/parsers/parsers.ts` (around line 1135). There are two changes:

**Change 1:** Add `inlineBlockParser` as an alternative in the `sepBy` argument list, tried before `exprParser`:

```typescript
    capture(
      sepBy(
        comma,
        or(
          namedArgumentParser,
          splatParser,
          lazy(() => inlineBlockParser),
          lazy(() => exprParser),
        ),
      ),
      "arguments",
    ),
```

**Change 2:** After the `seqC` parser succeeds, post-process the result to move any `BlockArgument` from `arguments` to `block`. Replace the simple `return parser(input)` with:

```typescript
  const result = parser(input);
  if (!result.success) return result;

  // Post-process: move inline block from arguments to block field
  const args = result.result.arguments as AgencyNode[];
  const blockIndex = args.findIndex((a: AgencyNode) => a.type === "blockArgument");
  if (blockIndex !== -1) {
    const inlineBlock = args[blockIndex] as BlockArgument;
    args.splice(blockIndex, 1);
    if (result.result.block) {
      // Both inline block and trailing block — parse error
      return failure("A function call cannot have both an inline block and a trailing 'as' block", input);
    }
    result.result.block = inlineBlock;
  }

  // Check for multiple inline blocks (they would have been parsed as args)
  const secondBlock = args.findIndex((a: AgencyNode) => a.type === "blockArgument");
  if (secondBlock !== -1) {
    return failure("A function call cannot have more than one block argument", input);
  }

  return result;
```

Note: `failure` is tarsec's function for creating a failure result (already imported in `parsers.ts`). Do not confuse with `fail`, which is a Parser that always fails — you need `failure()` here since you're returning a `ParserResult`, not constructing a parser.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- --reporter=verbose lib/parsers/blockArgument.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run the full parser test suite to check for regressions**

Run: `pnpm test:run -- --reporter=verbose lib/parsers/`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/blockArgument.test.ts
git commit -m "Wire inline blocks into function call parser with post-processing"
```

---

### Task 4: Add negative parser tests

**Files:**
- Test: `lib/parsers/blockArgument.test.ts`

- [ ] **Step 1: Write negative tests**

Add to the `"function call with block argument"` describe block in `lib/parsers/blockArgument.test.ts`:

```typescript
  it("fails when function call has two inline blocks", () => {
    const input = String.raw`foo(\x -> x + 1, \y -> y * 2)`;
    const result = functionCallParser(input);
    expect(result.success).toBe(false);
  });

  it("fails when function call has inline block and trailing as block", () => {
    const input = `map(arr, \\x -> x + 1) as y {
  return y
}`;
    const result = functionCallParser(input);
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm test:run -- --reporter=verbose lib/parsers/blockArgument.test.ts`
Expected: All tests pass (the negative tests should fail to parse as expected).

- [ ] **Step 3: Commit**

```bash
git add lib/parsers/blockArgument.test.ts
git commit -m "Add negative parser tests for multiple blocks in one call"
```

---

### Task 5: Integration test fixtures (TypeScript generator)

**Files:**
- Create: `tests/typescriptGenerator/inlineBlockBasic.agency`
- Create: `tests/typescriptGenerator/inlineBlockParams.agency`

These tests verify the full compilation pipeline: parse → preprocess → build → generate TypeScript. The `.mjs` fixture files will be generated by running `make fixtures`.

- [ ] **Step 1: Create `inlineBlockBasic.agency`**

```
def twice(block: () => string): string[] {
  let a: string = block()
  let b: string = block()
  return [a, b]
}

node main() {
  let results = twice(\ -> "hello")
  print(results)
}
```

- [ ] **Step 2: Create `inlineBlockParams.agency`**

```
def mapItems(items: any[], block: (any) => any): any[] {
  let results: any[] = []
  for (item in items) {
    let result = block(item)
    results = results.concat([result])
  }
  return results
}

node main() {
  let items = [1, 2, 3]
  let doubled = mapItems(items, \x -> x * 2)
  return doubled
}
```

- [ ] **Step 3: Generate the `.mjs` fixture files**

Run: `make fixtures`
Expected: `inlineBlockBasic.mjs` and `inlineBlockParams.mjs` are generated in `tests/typescriptGenerator/`.

- [ ] **Step 4: Verify the generated TypeScript looks correct**

Read the generated `.mjs` files. The inline block should compile to the same `AgencyFunction.create(...)` pattern as the trailing `as` blocks — compare with `tests/typescriptGenerator/blockBasic.mjs` for reference. The generated code should be functionally identical.

- [ ] **Step 5: Run the TypeScript generator tests**

Run: `pnpm test:run -- --reporter=verbose tests/typescriptGenerator/`
Expected: All tests pass including the new fixtures.

- [ ] **Step 6: Commit**

```bash
git add tests/typescriptGenerator/inlineBlockBasic.agency tests/typescriptGenerator/inlineBlockBasic.mjs
git add tests/typescriptGenerator/inlineBlockParams.agency tests/typescriptGenerator/inlineBlockParams.mjs
git commit -m "Add integration test fixtures for inline block syntax"
```

---

### Task 6: Agency execution tests

**Files:**
- Create: `tests/agency/blocks/block-inline-basic.agency`
- Create: `tests/agency/blocks/block-inline-basic.test.json`
- Create: `tests/agency/blocks/block-inline-params.agency`
- Create: `tests/agency/blocks/block-inline-params.test.json`

These tests compile AND execute `.agency` files, verifying the runtime output. They do NOT require LLM calls.

- [ ] **Step 1: Create `block-inline-basic.agency`**

```
def twice(block: () => string): string[] {
  let a: string = block()
  let b: string = block()
  return [a, b]
}

node main() {
  let results = twice(\ -> "hello")
  return results
}
```

- [ ] **Step 2: Create `block-inline-basic.test.json`**

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "[\"hello\",\"hello\"]",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ],
      "description": "Inline block with no params called twice returns two hello strings"
    }
  ]
}
```

- [ ] **Step 3: Create `block-inline-params.agency`**

```
def mapItems(items: any[], block: (any) => any): any[] {
  let results: any[] = []
  for (item in items) {
    let result = block(item)
    results = results.concat([result])
  }
  return results
}

node main() {
  let items = [1, 2, 3]
  let doubled = mapItems(items, \x -> x * 2)
  return doubled
}
```

- [ ] **Step 4: Create `block-inline-params.test.json`**

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "[2,4,6]",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ],
      "description": "Inline block with params maps items by doubling them"
    }
  ]
}
```

- [ ] **Step 5: Run the execution tests**

Run: `pnpm test:run -- --reporter=verbose tests/agency/blocks/block-inline`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/agency/blocks/block-inline-basic.agency tests/agency/blocks/block-inline-basic.test.json
git add tests/agency/blocks/block-inline-params.agency tests/agency/blocks/block-inline-params.test.json
git commit -m "Add execution tests for inline block syntax"
```

---

### Task 7: Interrupt execution test

**Files:**
- Create: `tests/agency/blocks/block-inline-interrupt.agency`
- Create: `tests/agency/blocks/block-inline-interrupt.test.json`

This test verifies that inline blocks work correctly with the interrupt/resume system — a critical safety feature.

- [ ] **Step 1: Create `block-inline-interrupt.agency`**

Model this after `tests/agency/blocks/block-interrupt.agency` but using inline block syntax. Since inline blocks are expression-only, the block expression itself should be a function call that interrupts. Look at the existing `block-interrupt.agency` test for the pattern:

```
def withApproval(block: () => string): string {
  let result = block()
  return result
}

def getApproval(): string {
  interrupt("please approve")
  return "approved"
}

node main() {
  let result = withApproval(\ -> getApproval())
  return result
}
```

- [ ] **Step 2: Create `block-inline-interrupt.test.json`**

Look at `tests/agency/blocks/block-interrupt.test.json` for the pattern used with interrupts. The test should approve the interrupt and verify the result. Here's the general shape (adapt based on what the existing interrupt tests look like):

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"approved\"",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ],
      "description": "Inline block that interrupts resumes correctly after approval",
      "interruptHandlers": [
        {
          "action": "approve"
        }
      ]
    }
  ]
}
```

This matches the existing `block-interrupt.test.json` format: the field is `"interruptHandlers"` (not `"interrupts"`), and string outputs are wrapped in escaped quotes (`"\"approved\""`).


- [ ] **Step 3: Run the test**

Run: `pnpm test:run -- --reporter=verbose tests/agency/blocks/block-inline-interrupt`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency/blocks/block-inline-interrupt.agency tests/agency/blocks/block-inline-interrupt.test.json
git commit -m "Add interrupt execution test for inline block syntax"
```

---

### Task 8: Full regression test

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test:run`
Expected: All tests pass. Pay special attention to:
- `lib/parsers/` — parser tests
- `tests/typescriptGenerator/` — code gen tests
- `tests/agency/blocks/` — block execution tests
- `tests/agency/substeps/` — checkpoint/nested block tests

- [ ] **Step 2: If any failures, fix them before proceeding**

Any failure at this stage likely means the new parser alternative is matching something it shouldn't, or the post-processing is interfering with existing block handling. Debug by checking which test fails and whether it involves function calls with arguments.

- [ ] **Step 3: Commit any fixes if needed**

---

### Task 9: Update documentation

**Files:**
- Modify: `docs-new/guide/blocks.md`

- [ ] **Step 1: Add inline block syntax section to blocks.md**

Add a new section after the opening example in `docs-new/guide/blocks.md`. Place it before the "Blocks and interrupts" section. The new section should document the inline syntax as a terse alternative:

```markdown
## Inline blocks

For simple one-liner blocks, you can use the inline block syntax. Instead of writing the block after the function call, you write it as an argument using `\`:

\```typescript
  const names: string[] = ["Alice", "Bob", "Charlie"]
  const greetings = map(names, \name -> "Hi, ${name}!")
  print(greetings)
\```

For multiple parameters, wrap them in parentheses:

\```typescript
  const greetings = mapWithIndex(names, \(name, index) -> "${index}: ${name}")
\```

For no parameters:

\```typescript
  const results = twice(\ -> "hello")
\```

Inline blocks are expression-only — the expression is implicitly returned. For multi-line blocks with multiple statements, use the trailing `as` syntax shown above.
```

(Remove the backslash escapes on the triple-backtick fences — those are just to prevent breaking this plan's markdown.)

- [ ] **Step 2: Commit**

```bash
git add docs-new/guide/blocks.md
git commit -m "Document inline block syntax in language guide"
```
