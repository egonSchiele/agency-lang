# Preserve Blank Lines in Formatter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve blank lines in Agency source code through the parse → format round-trip.

**Architecture:** A pre-pass replaces blank lines in raw source with a Unicode sentinel character (`\uE000`) before parsing. A small sentinel parser produces `BlankLine` AST nodes (a new type distinct from `NewLine`). The generator emits blank lines for those nodes. No existing parsers are modified.

**Tech Stack:** tarsec (parser combinators), vitest (tests)

---

### Task 1: Add the `BlankLine` AST type and sentinel constant

**Files:**
- Modify: `lib/types.ts`
- Create: `lib/parsers/blankLine.ts`

- [ ] **Step 1: Add the `BlankLine` type**

In `lib/types.ts`, add a new type near the existing `NewLine` type (~line 194):

```ts
export type BlankLine = BaseNode & {
  type: "blankLine";
};
```

Add `BlankLine` to the `AgencyNode` union type (~line 198):

```ts
export type AgencyNode =
  | TypeAlias
  | GraphNodeDefinition
  // ... existing types ...
  | NewLine
  | BlankLine   // <-- add here
```

- [ ] **Step 2: Create the sentinel constant file**

Create `lib/parsers/blankLine.ts` with the sentinel constant. This avoids a circular import between `lib/parser.ts` and `lib/parsers/parsers.ts`.

```ts
export const BLANK_LINE_SENTINEL = "\uE000";
```

- [ ] **Step 3: Commit**

```
git add lib/types.ts lib/parsers/blankLine.ts
git commit -m "feat(formatter): add BlankLine AST type and sentinel constant"
```

---

### Task 2: Add the pre-pass function

**Files:**
- Modify: `lib/parser.ts`
- Create: `lib/parser.test.ts`

The pre-pass scans raw source for blank lines and replaces every character in each blank line with `\uE000`. A blank line is a `\n` followed by optional spaces/tabs and another `\n`. Every character in the matched span is replaced, preserving the exact character count so `loc` data stays correct. Multiple consecutive blank lines are collapsed into a single sentinel span (same length).

- [ ] **Step 1: Write the failing test**

`lib/parser.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { replaceBlankLines } from "./parser.js";

const S = "\uE000";

describe("replaceBlankLines", () => {
  it("replaces a simple blank line", () => {
    const input = "a\n\nb";
    expect(replaceBlankLines(input)).toBe(`a${S}${S}b`);
  });

  it("replaces a blank line with spaces", () => {
    const input = "a\n   \nb";
    expect(replaceBlankLines(input)).toBe(`a${S}${S}${S}${S}${S}b`);
  });

  it("replaces multiple consecutive blank lines", () => {
    const input = "a\n\n\nb";
    expect(replaceBlankLines(input)).toBe(`a${S}${S}${S}b`);
  });

  it("preserves length", () => {
    const input = "hello\n   \n  world";
    expect(replaceBlankLines(input).length).toBe(input.length);
  });

  it("does not touch non-blank lines", () => {
    const input = "a\nb\nc";
    expect(replaceBlankLines(input)).toBe("a\nb\nc");
  });

  it("handles blank line at start of input", () => {
    const input = "\n\na";
    expect(replaceBlankLines(input)).toBe(`${S}${S}a`);
  });

  it("handles blank line at end of input", () => {
    const input = "a\n\n";
    expect(replaceBlankLines(input)).toBe(`a${S}${S}`);
  });

  it("handles \\r\\n line endings", () => {
    const input = "a\r\n\r\nb";
    expect(replaceBlankLines(input)).toBe(`a${S}${S}${S}${S}b`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/parser.test.ts 2>&1 | tee $TMPDIR/task2-step2.log`
Expected: FAIL — `replaceBlankLines` is not exported.

- [ ] **Step 3: Implement `replaceBlankLines`**

In `lib/parser.ts`, import the sentinel and add the function near `normalizeCode` (~line 108):

```ts
import { BLANK_LINE_SENTINEL } from "./parsers/blankLine.js";

/**
 * Replace blank lines with sentinel characters, preserving string length
 * so that loc data (character offsets) remains correct.
 *
 * A "blank line" is a \n followed by optional [ \t] and another \n (or \r\n).
 * Every character in the blank line span (including both newlines) is replaced
 * with \uE000. Multiple consecutive blank lines become a single sentinel span.
 */
export function replaceBlankLines(input: string): string {
  return input.replace(/\n([ \t]*\r?\n)+/g, (match) =>
    BLANK_LINE_SENTINEL.repeat(match.length)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/parser.test.ts 2>&1 | tee $TMPDIR/task2-step4.log`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add lib/parser.ts lib/parser.test.ts
git commit -m "feat(formatter): add replaceBlankLines pre-pass function"
```

---

### Task 3: Wire the pre-pass into `_parseAgency`

**Files:**
- Modify: `lib/parser.ts`

Call `replaceBlankLines` in `_parseAgency` so all parsing gets blank-line sentinel support.

- [ ] **Step 1: Wire it in**

In `_parseAgency` (~line 112), apply `replaceBlankLines` after `normalizeCode`. Change:

```ts
  setInputStr(normalized);
```
to:
```ts
  const withSentinels = replaceBlankLines(normalized);
  setInputStr(withSentinels);
```

And change:
```ts
  const result = agencyParser(normalized);
```
to:
```ts
  const result = agencyParser(withSentinels);
```

And in the failure branch, change:
```ts
      return failure(betterMessage, normalized);
```
to:
```ts
      return failure(betterMessage, withSentinels);
```

- [ ] **Step 2: Run existing tests to verify nothing breaks**

Run: `pnpm test:run lib/parser.test.ts 2>&1 | tee $TMPDIR/task3-step2.log`
Expected: PASS (blank-line sentinels are harmless since no parser matches `\uE000` yet)

- [ ] **Step 3: Commit**

```
git add lib/parser.ts
git commit -m "feat(formatter): wire replaceBlankLines into _parseAgency"
```

---

### Task 4: Add the sentinel parser to the body parser and top-level parser

**Files:**
- Modify: `lib/parsers/blankLine.ts`
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/parser.ts`
- Create: `lib/parsers/blankLine.test.ts`

Add a parser that matches one or more `\uE000` characters and produces a `BlankLine` AST node. Add it to both the body parser and top-level parser `or` chains.

- [ ] **Step 1: Write the failing test**

`lib/parsers/blankLine.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

describe("blank line parsing", () => {
  it("produces a blankLine node for a blank line between statements", () => {
    const input = `node main() {\n  print("a")\n\n  print("b")\n}\n`;
    const result = parseAgency(input, {}, false);
    if (!result.success) throw new Error("parse failed");

    const body = (result.result.nodes[0] as any).body;
    const types = body.map((n: any) => n.type);
    expect(types).toContain("blankLine");
  });

  it("produces a blankLine node for a blank line with spaces", () => {
    const input = `node main() {\n  print("a")\n   \n  print("b")\n}\n`;
    const result = parseAgency(input, {}, false);
    if (!result.success) throw new Error("parse failed");

    const body = (result.result.nodes[0] as any).body;
    const types = body.map((n: any) => n.type);
    expect(types).toContain("blankLine");
  });

  it("collapses multiple consecutive blank lines into one blankLine node", () => {
    const input = `node main() {\n  print("a")\n\n\n\n  print("b")\n}\n`;
    const result = parseAgency(input, {}, false);
    if (!result.success) throw new Error("parse failed");

    const body = (result.result.nodes[0] as any).body;
    const blankLines = body.filter((n: any) => n.type === "blankLine");
    expect(blankLines.length).toBe(1);
  });

  it("does not produce blankLine nodes when there are no blank lines", () => {
    const input = `node main() {\n  print("a")\n  print("b")\n}\n`;
    const result = parseAgency(input, {}, false);
    if (!result.success) throw new Error("parse failed");

    const body = (result.result.nodes[0] as any).body;
    const types = body.map((n: any) => n.type);
    expect(types).not.toContain("blankLine");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/parsers/blankLine.test.ts 2>&1 | tee $TMPDIR/task4-step2.log`
Expected: FAIL — no parser matches sentinel.

- [ ] **Step 3: Add the sentinel parser**

In `lib/parsers/blankLine.ts`, add the parser:

```ts
import { char, many1, map, Parser } from "tarsec";
import { BlankLine } from "../types.js";

export const BLANK_LINE_SENTINEL = "\uE000";

export const blankLineParser: Parser<BlankLine> = map(
  many1(char(BLANK_LINE_SENTINEL)),
  () => ({ type: "blankLine" as const }),
);
```

In `lib/parsers/parsers.ts`, import and add `blankLineParser` to `bodyNodeParser`'s `or` chain (~line 2157), just before `newLineParser`:

```ts
import { blankLineParser } from "./blankLine.js";
```

```ts
  const bodyNodeParser = or(
    // ... all existing parsers ...
    literalParser,
    blankLineParser,  // <-- add here
    newLineParser,
  );
```

In `lib/parser.ts`, import `blankLineParser` and add it to the top-level `nodeParser` `or` chain (~line 85), just before `newLineParser`:

```ts
import { blankLineParser } from "./parsers/blankLine.js";
```

```ts
const nodeParser = or(
  // ... all existing parsers ...
  commentParser,
  blankLineParser,  // <-- add here
  newLineParser,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/parsers/blankLine.test.ts 2>&1 | tee $TMPDIR/task4-step4.log`
Expected: PASS

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/task4-step5.log`
Expected: PASS — the TypeScript builder handles `newLine` with `ts.empty()` (line 866). You need to add a `blankLine` case there too that also returns `ts.empty()`. Same for the preprocessor skip lists — add `"blankLine"` wherever `"newLine"` appears in skip/filter lists:

- `lib/backends/typescriptBuilder.ts` ~line 866: add `case "blankLine": return ts.empty();`
- `lib/backends/typescriptBuilder.ts` ~line 399: add `"blankLine"` to `TOP_LEVEL_DECLARATION_TYPES`
- `lib/preprocessors/typescriptPreprocessor.ts` ~line 178: add `"blankLine"` to `SKIP_TYPES`
- `lib/preprocessors/typescriptPreprocessor.ts` ~line 223: add `node.type === "blankLine"` to the skip condition
- `lib/preprocessors/parallelDesugar.ts` ~line 63: add `"blankLine"` to the skip set
- `lib/preprocessors/parallelDesugar.ts` ~line 66: add `"blankLine"` to `COMMENT_TYPES`
- `lib/config.ts` ~line 6: add `"blankLine"` to `TYPES_THAT_DONT_TRIGGER_NEW_PART`
- `lib/parsers/vitest.setup.ts` ~line 23: add `item.type === "blankLine"` to the newline-stripping filter so existing parser tests using `toEqualWithoutLoc` aren't broken by new `blankLine` nodes

After these additions, re-run: `pnpm test:run 2>&1 | tee $TMPDIR/task4-step5b.log`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add lib/parsers/blankLine.ts lib/parsers/parsers.ts lib/parser.ts lib/parsers/blankLine.test.ts lib/backends/typescriptBuilder.ts lib/preprocessors/typescriptPreprocessor.ts lib/preprocessors/parallelDesugar.ts lib/config.ts lib/parsers/vitest.setup.ts
git commit -m "feat(formatter): add sentinel parser for blank lines"
```

---

### Task 5: Update the generator to emit blank lines

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/formatter.test.ts`

Add a `processBlankLine` method and update body renderers to preserve blank lines while still filtering out other empty strings.

- [ ] **Step 1: Write the failing test**

Add round-trip tests to `lib/formatter.test.ts`:

```ts
it("preserves blank lines between statements", () => {
  const input = 'node main() {\n  print("a")\n\n  print("b")\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain('print("a")\n\n  print("b")');
});

it("preserves multiple blank line regions", () => {
  const input = 'node main() {\n  print("a")\n\n  print("b")\n\n  print("c")\n}\n';
  const formatted = formatSource(input);
  const matches = formatted!.match(/\n\n/g);
  expect(matches?.length).toBe(2);
});

it("collapses multiple consecutive blank lines into one", () => {
  const input = 'node main() {\n  print("a")\n\n\n\n  print("b")\n}\n';
  const formatted = formatSource(input);
  expect(formatted).toContain('print("a")\n\n  print("b")');
  expect(formatted).not.toContain('\n\n\n');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/task5-step2.log`
Expected: FAIL — blank lines are still being filtered out.

- [ ] **Step 3: Add `blankLine` handling to the generator**

In `lib/backends/agencyGenerator.ts`:

1. Import the `BlankLine` type at the top:
```ts
import { BlankLine } from "../types.js";
```
(Or add it to the existing import from `"../types.js"`.)

2. Add a case in `processNode` (~line 244, near the `newLine` case):
```ts
      case "blankLine":
        return this.processBlankLine(node);
```

3. Add the method (near `processNewLine` ~line 983):
```ts
  protected processBlankLine(_node: BlankLine): string {
    return "";
  }
```

4. Update every body renderer to preserve blank-line `""` values. Change the pattern in each method from:
```ts
const lines: string[] = [];
for (const stmt of body) {
  lines.push(this.processNode(stmt));
}
const bodyCode =
  lines
    .filter((s) => s !== "")
    .join("\n")
    .trimEnd() + "\n";
```
to:
```ts
const lines: string[] = [];
for (const stmt of body) {
  const line = this.processNode(stmt);
  if (line !== "" || stmt.type === "blankLine") {
    lines.push(line);
  }
}
const bodyCode = lines.join("\n").trimEnd() + "\n";
```

Apply this change in these methods:
- `processFunctionDefinition` (~line 529-537)
- `generateFunctionCallExpression` (~line 601-610)
- `processForLoop` (~line 720-728)
- `processWhileLoop` (~line 742-749)
- `processIfElse` (~lines 762-772, ~lines 783-792)
- `processGraphNode` (~line 911-919)
- `processClassDefinition` (~line 955-963)
- `processMessageThread` (~line 989-998)
- `processParallelBlock` (~line 1007-1016)
- `processSeqBlock` (~line 1025-1033)
- `processHandleBlock` (~lines 1041-1050, ~lines 1059-1068)

Note: each method accesses the body array differently (some as `body`, some as `node.body`, some as `block.body`). The key change is: replace the `for + push` loop with one that checks `stmt.type === "blankLine"` before filtering, and remove the separate `.filter()` call.

- [ ] **Step 4: Run formatter test to verify it passes**

Run: `pnpm test:run lib/formatter.test.ts 2>&1 | tee $TMPDIR/task5-step4.log`
Expected: PASS

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/task5-step5.log`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add lib/backends/agencyGenerator.ts lib/formatter.test.ts
git commit -m "feat(formatter): emit blank lines for BlankLine AST nodes"
```

---

### Task 6: End-to-end verification with foo-orig.agency

**Files:**
- No file changes — verification only.

- [ ] **Step 1: Run the formatter on foo-orig.agency and verify blank lines are preserved**

Run: `pnpm run fmt foo-orig.agency 2>&1 | tee $TMPDIR/task6-step1.log`

Expected output should have blank lines between statement groups, matching the original:
```
node main() {
  print(color.cyan("Welcome to the Agency Agent!"))
  print(color.cyan("Would you like to create a new agent or modify an existing one?"))

  userinput = input("(create/modify) ")

  thread {
    mode: Mode = llm("categorize this user response as 'create' or 'modify': ${userinput}", config)
  }

  print(color.cyan("Great! Let's ${mode} an agent."))

  match(mode) {
    "create" => return plan("create", "", null)
    "modify" => return readExisting()
  }
}
```

- [ ] **Step 2: Run the full test suite one final time**

Run: `pnpm test:run 2>&1 | tee $TMPDIR/task6-step2.log`
Expected: PASS
