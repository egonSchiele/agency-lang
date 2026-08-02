# Language-Wide Trailing Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve an end-of-line `//` comment beside the complete declaration, statement, match arm, or multiline-list item it describes everywhere Agency already permits multiline layout.

**Architecture:** A reusable `completeConstructEntry` parser handles attachment and post-comment layout at top level, in bodies, and in match arms. A compatibility-preserving `ListTrivia` model handles comments after separators in multiline lists, with one list engine configured by explicit cardinality/trailing-comma policies and a separate object-member policy. Comment and list-item rendering use structured, declarative results; cursor movement and indentation stay inside the shared helpers.

**Tech Stack:** TypeScript, tarsec parser combinators, Vitest, `AgencyGenerator`.

Spec: `docs/superpowers/specs/2026-07-31-trailing-comments-design.md`

## Global Constraints

- One user rule: a same-line `//` comment after a complete construct stays attached when formatted.
- Support top-level declarations/statements, all body statements, match arms, and every list grammar that already permits line breaks.
- For comma lists, the comma precedes the comment: `item, // comment`.
- Do not make inline-only grammars multiline. Tags, generics, value-parameterized types, effect/raises lists, block-type parameters, block/lambda parameters, and `new` arguments stay out of scope.
- Do not attach trailing `/* ... */` comments. Existing block-comment trivia must not regress.
- Do not introduce a wrapper AST node. Handler registration and invocation must remain unchanged.
- Do not extend the owner's `loc.end` through the attached comment.
- Existing ASTs without trailing comments must not gain fields.
- Existing before-trivia records must not gain a `placement` field.
- Preserve the exported `Trivia` and `ObjectTypeTrivia` names as aliases.
- Preserve required-comma behavior in arrays, objects, and every comma list.
- Trivia forces multiline output. Trivia-free input keeps existing compact/wrapping behavior.
- Use `parseAgency(src, {}, false, false)` for raw parser assertions and `formatSource(src)` for formatter assertions.
- Run tests with `pnpm test:run`, save output once, and inspect the saved file rather than rerunning expensive suites.
- Use `pnpm run typecheck` so test files are type-checked through `tsconfig.tests.json`.
- Use `pnpm run test:perf` for parser performance.
- Run `make` before the full test suite in a fresh worktree.
- Never use dynamic imports, `Map`, `Set`, one-line `if` statements, nested ternaries, or duplicated comment rendering.
- Never amend or force-push. Put commit messages containing punctuation or apostrophes in a file and use `git commit -F`.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `lib/types/base.ts` | `LineComment` and complete-node metadata | 1 |
| `lib/types/dataStructures.ts` | Shared `ListTrivia` model and literal owner fields | 3 |
| `lib/types/typeHints.ts` | Compatibility alias for object-type trivia | 3 |
| `lib/types/function.ts` | Argument and function-parameter trivia owners | 4 |
| `lib/types/graphNode.ts` | Node-parameter trivia owner | 4 |
| `lib/types/access.ts` | Call-chain argument trivia owner | 4 |
| `lib/types/interruptStatement.ts` | Interrupt/raise argument trivia owner | 4 |
| `lib/types/guardBlock.ts` | Guard argument trivia owner | 4 |
| `lib/types/matchBlock.ts` | Match-arm trailing metadata | 2 |
| `lib/types/importStatement.ts` | Import-list trivia owners | 5 |
| `lib/types/exportFromStatement.ts` | Export-list trivia owner | 5 |
| `lib/types/pattern.ts` | Pattern-list trivia owners | 5 |
| `lib/types/messageThread.ts` | Thread-argument trivia owner | 5 |
| `lib/types/parallelBlock.ts` | Parallel-argument trivia owner | 5 |
| `lib/parsers/parsers.ts` | Exact comment parser, decorator, list parsing, and all parser integrations | 1–5 |
| `lib/parser.ts` | Top-level decorator integration | 1 |
| `lib/backends/agencyGenerator.ts` | Shared comment/list rendering and all formatter integrations | 2–5 |
| `lib/parsers/trailingComments.test.ts` | Complete-construct attachment and location tests | 1–2 |
| `lib/parsers/listTrailingComments.test.ts` | Shared list AST and parser tests | 3–5 |
| `lib/formatter.test.ts` | Canonical output and fixed-point tests | 2–5 |
| Existing focused parser/generator tests | Compatibility and grammar regressions | 3–5 |
| `docs/site/guide/basic-syntax.md` | Universal user-facing rule | 6 |

Tasks are ordered by interface dependency. Each task ends in a usable,
independently reviewable milestone.

---

### Task 1: Complete-construct parser infrastructure

**Files:**
- Modify: `lib/types/base.ts`
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/parser.ts`
- Create: `lib/parsers/trailingComments.test.ts`

**Interfaces:**
- Produces: `LineComment`, `BaseNode.trailingComment?: LineComment`,
  `lineCommentCore`, `withTrailingLineComment<T>()`, and
  `completeConstructEntry<T>()`.
- Produces: decorated top-level and body node streams.
- Consumed by: Tasks 2–5.

- [ ] **Step 1: Write failing attachment and newline-boundary tests**

Create `lib/parsers/trailingComments.test.ts` with raw-AST helpers and these cases:

```ts
import { describe, expect, it } from "vitest";
import { parseAgency } from "@/parser.js";

function parseRaw(source: string) {
  const parsed = parseAgency(source, {}, false, false);
  if (!parsed.success) {
    throw new Error(`expected parse success: ${parsed.message}`);
  }
  return parsed.result;
}

function mainBody(source: string): any[] {
  return (parseRaw(source).nodes[0] as any).body;
}

describe("complete-construct trailing comment attachment", () => {
  it("attaches to a top-level declaration", () => {
    const nodes = parseRaw(`type UserId = string // identifier\n`).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].trailingComment).toMatchObject({
      type: "comment",
      content: " identifier",
    });
  });

  it("attaches to a body statement instead of adding a sibling", () => {
    const body = mainBody(
      `node main() {\n  const x = 5 // explains x\n  const y = 6\n}\n`,
    );
    expect(body).toHaveLength(2);
    expect(body[0].trailingComment?.content).toBe(" explains x");
  });

  it.each([
    ["assignment", `const x = 5`],
    ["return", `return 5`],
    ["raise", `raise("stop")`],
    ["call", `print(1)`],
    ["block", `if (true) {\n    print(1)\n  }`],
  ])("does not attach a standalone comment after %s", (_name, statement) => {
    const body = mainBody(
      `node main() {\n  ${statement}\n  // standalone\n  print(2)\n}\n`,
    );
    expect(body[0].trailingComment).toBeUndefined();
    expect(body.some((node) => node.type === "comment")).toBe(true);
  });

  it("does not attach to a blank-line node", () => {
    const body = mainBody(
      `node main() {\n  print(1)\n\n  // standalone\n  print(2)\n}\n`,
    );
    const blank = body.find((node) => node.type === "newLine");
    expect(blank?.trailingComment).toBeUndefined();
    expect(body.some((node) => node.type === "comment")).toBe(true);
  });

  it("does not attach a block comment", () => {
    const body = mainBody(
      `node main() {\n  const x = 5 /* why */\n  const y = 6\n}\n`,
    );
    expect(body[0].trailingComment).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and save the expected failure**

```bash
pnpm test:run lib/parsers/trailingComments.test.ts > /tmp/trailing-task1-red.txt 2>&1; echo $?
```

Expected: exit 1. The positive attachment assertions fail; the negative cases
describe current behavior.

- [ ] **Step 3: Add the leaf type without an aggregate import cycle**

Replace the end of `lib/types/base.ts` with:

```ts
export type LineComment = {
  type: "comment";
  content: string;
  loc?: SourceLocation;
};

export type BaseNode = {
  loc?: SourceLocation;
  /** A same-line `//` comment attached for Agency source formatting. */
  trailingComment?: LineComment;
};
```

Do not import `AgencyComment` from `../types.js`; that aggregate module imports
`BaseNode` and would invert the foundational type dependency.

- [ ] **Step 4: Split exact comment text from standalone whitespace policy**

Replace `commentParser` in `lib/parsers/parsers.ts` with:

```ts
export const lineCommentCore: Parser<AgencyComment> = seqC(
  set("type", "comment"),
  str("//"),
  capture(manyTill(or(newline, blankLineParser)), "content"),
);

export const commentParser: Parser<AgencyComment> = map(
  seqC(
    optionalSpaces,
    capture(lineCommentCore, "comment"),
    optionalSpacesOrNewline,
  ),
  (result) => result.comment,
);
```

This preserves standalone comment behavior while giving the decorator a parser
that starts exactly at `//` and does not consume the line ending.

- [ ] **Step 5: Add the reusable decorator**

Import `LineComment` from `../types/base.js` in the parser type-import section,
then add beside the body parser utilities:

```ts
type TrailingCommentOwner = {
  type: string;
  trailingComment?: LineComment;
};

const NON_TRAILING_OWNER_TYPES = [
  "comment",
  "multiLineComment",
  "newLine",
];

type TrailingCommentOptions<T> = {
  canAttach?: (value: T) => boolean;
};

function consumedLineEnding(input: string, rest: string): boolean {
  const consumedLength = input.length - rest.length;
  const consumed = input.slice(0, consumedLength);
  const trailingWhitespace = consumed.match(/[ \t\r\n]*$/)?.[0] ?? "";
  return /[\r\n]/.test(trailingWhitespace);
}

export function withTrailingLineComment<T extends TrailingCommentOwner>(
  parser: Parser<T>,
  options: TrailingCommentOptions<T> = {},
): Parser<T> {
  return (input: string) => {
    const parsed = parser(input);
    if (!parsed.success) {
      return parsed;
    }

    if (options.canAttach && !options.canAttach(parsed.result)) {
      return parsed;
    }

    if (consumedLineEnding(input, parsed.rest)) {
      return parsed;
    }

    const comment = seqR(optionalSpaces, lineCommentCore)(parsed.rest);
    if (!comment.success) {
      return parsed;
    }

    return success(
      { ...parsed.result, trailingComment: comment.result },
      comment.rest,
    );
  };
}

export function completeConstructEntry<T extends TrailingCommentOwner>(
  parser: Parser<T>,
  options?: TrailingCommentOptions<T>,
): Parser<T> {
  return map(
    seqC(
      capture(withTrailingLineComment(parser, options), "value"),
      optionalSpacesOrNewline,
    ),
    (result) => result.value,
  );
}
```

`withTrailingLineComment` owns the same-line decision. `completeConstructEntry`
owns the terminating layout whether or not a comment attached, so match arms
cannot strand the newline left by `lineCommentCore`. The functions are
imperative internally because they coordinate parser state, but grammar call
sites only select a parser and, when needed, a declarative attachment policy.

- [ ] **Step 6: Decorate body and top-level streams**

In `lib/parsers/parsers.ts`, replace `_bodyParserImpl` with:

```ts
const _bodyParserImpl: Parser<AgencyNode[]> = memo(
  "functionBodyParser",
  many(
    completeConstructEntry(_bodyNodeParser, {
      canAttach: (node) => !NON_TRAILING_OWNER_TYPES.includes(node.type),
    }),
  ),
);
```

In `lib/parser.ts`, import `completeConstructEntry`, rename the current
`nodeParser` to `nodeParserInner`, and declare:

```ts
const nodeParser = completeConstructEntry(nodeParserInner);
```

Remove any now-duplicated post-node whitespace consumption from `agencyNode`;
`completeConstructEntry` is the single owner of that boundary.

- [ ] **Step 7: Run focused parser and location tests**

```bash
pnpm test:run lib/parsers/trailingComments.test.ts lib/parser.test.ts lib/parsers/body.test.ts lib/parsers/comment.test.ts lib/parsers/blankLine.test.ts lib/parsers/matchBlock.test.ts > /tmp/trailing-task1-green.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 8: Type-check production and tests**

```bash
pnpm run typecheck > /tmp/trailing-task1-types.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 9: Commit**

Write this message to `/tmp/trailing-task1-commit.txt`:

```text
parser: attach trailing comments to complete nodes

Keep same-line comments with top-level and body constructs without crossing a
consumed newline or changing the owner's source location.
```

Then run:

```bash
git add lib/types/base.ts lib/parsers/parsers.ts lib/parser.ts lib/parsers/trailingComments.test.ts
git commit -F /tmp/trailing-task1-commit.txt
```

---

### Task 2: Render complete constructs and match arms

**Files:**
- Modify: `lib/types/matchBlock.ts`
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/parsers/trailingComments.test.ts`
- Modify: `lib/formatter.test.ts`

**Interfaces:**
- Consumes: `LineComment`, `withTrailingLineComment`.
- Produces: `commentText`, `appendTrailingComment`, match-arm metadata, and
  canonical complete-construct output.
- Consumed by: Tasks 3–5.

- [ ] **Step 1: Add failing formatter, match-arm, import-sorting, and location tests**

Add a formatter helper and cases to `lib/formatter.test.ts`:

```ts
function expectTrailingCommentFixedPoint(source: string, expected: string): void {
  const once = formatSource(source);
  expect(once).not.toBeNull();
  expect(once).toBe(expected);
  expect(formatSource(once as string)).toBe(once);
  expect(parseAgency(once as string, {}, false, false).success).toBe(true);
}

describe("complete-construct trailing comments", () => {
  it("preserves top-level and body comments", () => {
    expectTrailingCommentFixedPoint(
      `type UserId=string // id\nnode main(){\nconst x=5 // x\n}\n`,
      `type UserId = string // id\n\nnode main() {\n  const x = 5 // x\n}\n`,
    );
  });

  it("keeps comments with imports while sorting", () => {
    const formatted = formatSource(
      `import { z } from "./z" // z comment\nimport { a } from "./a" // a comment\n`,
    );
    expect(formatted).toContain(
      `import { a } from "./a" // a comment\nimport { z } from "./z" // z comment`,
    );
  });

  it("keeps a comment after a multiline call closing delimiter", () => {
    const source = `node main() {\n  save(\n    "a very long argument that keeps this call multiline",\n    "another very long argument that keeps this call multiline"\n  ) // whole call\n}\n`;
    const once = formatSource(source);
    expect(once).toContain(`\n  ) // whole call\n`);
    expect(formatSource(once as string)).toBe(once);
  });
});
```

In `lib/parsers/trailingComments.test.ts`, add a focused location assertion that
uses the source offsets rather than assuming a nonexistent location suite:

```ts
it("does not extend the owner location through the comment", () => {
  const source = `type UserId = string // identifier\n`;
  const node = parseRaw(source).nodes[0];
  expect(node.trailingComment?.content).toBe(" identifier");
  expect(source.slice(node.loc!.start, node.loc!.end)).not.toContain("//");
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
pnpm test:run lib/parsers/trailingComments.test.ts lib/formatter.test.ts > /tmp/trailing-task2-red.txt 2>&1; echo $?
```

Expected: exit 1 because the generator does not emit attached metadata.

- [ ] **Step 3: Separate comment text from placement**

Import `LineComment` into `lib/backends/agencyGenerator.ts`, then replace
`processComment` and add one placement helper:

```ts
protected commentText(comment: LineComment): string {
  return `//${comment.content}`;
}

protected processComment(comment: AgencyComment): string {
  return this.indentStr(this.commentText(comment));
}

protected appendTrailingComment(
  code: string,
  comment: LineComment | undefined,
): string {
  if (!comment || code === "") {
    return code;
  }
  return `${code} ${this.commentText(comment)}`;
}
```

This is the single owner of line-comment source text. Do not reconstruct
`//${comment.content}` anywhere else.

- [ ] **Step 4: Emit complete-node metadata once**

Replace `processNode` with:

```ts
public processNode(node: AgencyNode): string {
  const result = this.processNodeInner(node);
  const traced = this.trace(node.type, result);
  return this.appendTrailingComment(traced, node.trailingComment);
}
```

In `sortAndRenderImports`, update `renderWithAttached` so the sorted path—which
bypasses `processNode`—also moves a trailing comment with its import:

```ts
const renderWithAttached = (
  node: ImportStatement | ImportNodeStatement,
  body: string,
): string => {
  const rendered = this.appendTrailingComment(body, node.trailingComment);
  const attached = this.importAttachedComments.get(node) ?? [];
  if (attached.length === 0) {
    return rendered;
  }
  const commentLines = attached.map((comment) => this.processNode(comment));
  return [...commentLines, rendered].join("\n");
};
```

- [ ] **Step 5: Decorate and render match arms**

In `lib/types/matchBlock.ts`, import `LineComment` from `./base.js` and add:

```ts
trailingComment?: LineComment;
```

to `MatchBlockCase`.

In `lib/parsers/parsers.ts`, rename the existing implementation to
`matchBlockParserCaseInner`, then export the complete stream entry:

```ts
export const matchBlockParserCase = completeConstructEntry(
  matchBlockParserCaseInner,
);
```

Remove the match loop's now-duplicated post-case whitespace handling. Add a raw
parser case with two arms where the first has a trailing comment; assert both
arms parse and remain separate. This pins the progress invariant that the
entry consumes the line ending after `lineCommentCore` stops.

In `processMatchBlock`, build the complete arm first, then append metadata:

```ts
const arm = this.armPrintsInline(caseNode)
  ? this.renderInlineMatchArm(caseNode, pattern, guardCode)
  : this.renderBlockMatchArm(caseNode, pattern, guardCode);
result += this.appendTrailingComment(arm, caseNode.trailingComment) + "\n";
```

Extract `renderInlineMatchArm` and `renderBlockMatchArm` from the existing two
branches without changing their internal formatting. The extracted methods
return one arm without its final newline; this gives `appendTrailingComment` a
complete construct and avoids duplicating comment emission.

- [ ] **Step 6: Add the complete body-owner matrix**

Add to `lib/formatter.test.ts`:

```ts
it.each([
  ["node", `node main() {\n  print(1) // c\n}\n`],
  ["function", `def f() {\n  print(1) // c\n}\n`],
  ["if", `node main() {\n  if (true) {\n    print(1) // c\n  }\n}\n`],
  ["else", `node main() {\n  if (true) {\n    print(1)\n  } else {\n    print(2) // c\n  }\n}\n`],
  ["while", `node main() {\n  while (true) {\n    print(1) // c\n  }\n}\n`],
  ["for", `node main() {\n  for (x in xs) {\n    print(x) // c\n  }\n}\n`],
  ["thread", `node main() {\n  thread {\n    print(1) // c\n  }\n}\n`],
  ["subthread", `node main() {\n  subthread {\n    print(1) // c\n  }\n}\n`],
  ["guard", `node main() {\n  guard() {\n    print(1) // c\n  }\n}\n`],
  ["handle", `node main() {\n  handle {\n    print(1) // c\n  } with approve\n}\n`],
  ["inline handler", `node main() {\n  handle {\n    print(1)\n  } with (answer) {\n    print(answer) // c\n  }\n}\n`],
  ["finalize", `node main() {\n  finalize {\n    print(1) // c\n  }\n}\n`],
  ["parallel", `node main() {\n  parallel {\n    print(1) // c\n  }\n}\n`],
  ["seq", `node main() {\n  seq {\n    print(1) // c\n  }\n}\n`],
  ["destructive", `node main() {\n  destructive {\n    print(1) // c\n  }\n}\n`],
  ["block match arm", `node main() {\n  match (x) {\n    1 => {\n      print(1) // c\n    }\n  }\n}\n`],
])("preserves a trailing comment in a %s body", (_name, source) => {
  const once = formatSource(source);
  expect(once).toContain("print(1) // c");
  expect(parseAgency(once as string, {}, false, false).success).toBe(true);
  expect(formatSource(once as string)).toBe(once);
});
```

Add focused existing-syntax cases for a braced block argument and a
statement-kind code literal using canonical examples from their existing test
files; assert the same parse/fixed-point contract.

- [ ] **Step 7: Run complete-construct suites**

```bash
pnpm test:run lib/parsers/trailingComments.test.ts lib/formatter.test.ts lib/backends/agencyGenerator.test.ts lib/parsers/matchBlock.test.ts lib/parsers/arrowBlocks.test.ts lib/parsers/codeLiteral.test.ts > /tmp/trailing-task2-green.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 8: Commit**

Write `/tmp/trailing-task2-commit.txt`:

```text
fmt: preserve trailing comments on complete constructs

Render attached comments for top-level nodes, every body owner, sorted imports,
and match arms through shared comment-text and placement helpers.
```

Then run:

```bash
git add lib/types/matchBlock.ts lib/parsers/parsers.ts lib/backends/agencyGenerator.ts lib/parsers/trailingComments.test.ts lib/formatter.test.ts
git commit -F /tmp/trailing-task2-commit.txt
```

---

### Task 3: Shared list trivia and existing trivia-aware lists

**Files:**
- Modify: `lib/types/dataStructures.ts`
- Modify: `lib/types/typeHints.ts`
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/backends/agencyGenerator.ts`
- Create: `lib/parsers/listTrailingComments.test.ts`
- Modify: `lib/parsers/dataStructures.test.ts`
- Modify: `lib/parsers/objectTypeTrivia.test.ts`
- Modify: `lib/parsers/literalDelimiter.test.ts`
- Modify: `lib/backends/agencyGenerator.test.ts`

**Interfaces:**
- Produces: `ListTrivia`, compatibility aliases, `ParsedList<T>`, shared
  partition/remap helpers, and trivia-aware list rendering.
- Consumed by: Tasks 4–5.

- [ ] **Step 1: Write failing compatibility and placement tests**

Create `lib/parsers/listTrailingComments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatSource } from "@/formatter.js";
import {
  agencyArrayParser,
  agencyObjectParser,
  objectTypeParser,
} from "./parsers.js";

describe("list trailing trivia", () => {
  it("distinguishes a trailing comment from a comment before the next item", () => {
    const parsed = agencyArrayParser(`[
      first, // explains first
      // prepares second
      second
    ]`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.result.trivia).toEqual([
      {
        anchorIndex: 0,
        placement: "trailing",
        comments: [{ type: "comment", content: " explains first" }],
      },
      {
        anchorIndex: 1,
        comments: [{ type: "comment", content: " prepares second" }],
      },
    ]);
  });

  it.each([
    ["array", `const value = [\n  1, // one\n  2 // two\n]\n`],
    ["object", `const value = {\n  one: 1, // one\n  two: 2 // two\n}\n`],
    ["object type", `type Value = {\n  one: number // one\n  two: number // two\n}\n`],
  ])("formats trailing comments in a %s", (_name, source) => {
    const once = formatSource(source);
    expect(once).toContain("// one");
    expect(once).toContain("// two");
    expect(formatSource(once as string)).toBe(once);
  });
});
```

Retain the existing exact AST assertions in `dataStructures.test.ts` and
`objectTypeTrivia.test.ts`; they are the compatibility tests proving ordinary
trivia still omits `placement`.

- [ ] **Step 2: Run the new and existing tests to verify the red state**

```bash
pnpm test:run lib/parsers/listTrailingComments.test.ts lib/parsers/dataStructures.test.ts lib/parsers/objectTypeTrivia.test.ts lib/parsers/literalDelimiter.test.ts lib/backends/agencyGenerator.test.ts > /tmp/trailing-task3-red.txt 2>&1; echo $?
```

Expected: exit 1 only in the new trailing-placement cases.

- [ ] **Step 3: Introduce compatibility-preserving shared trivia types**

In `lib/types/dataStructures.ts`, import `LineComment` from `./base.js` and
replace `Trivia` with:

```ts
export type BeforeListTrivia = {
  /** Index of the item this trivia precedes; item count means the closer. */
  anchorIndex: number;
  comments: TriviaNode[];
  /** Omitted by parsers to preserve existing serialized ASTs. */
  placement?: "before";
};

export type TrailingListTrivia = {
  /** Index of the item this line comment follows. */
  anchorIndex: number;
  placement: "trailing";
  comments: [LineComment];
};

export type ListTrivia = BeforeListTrivia | TrailingListTrivia;
export type Trivia = ListTrivia;

export type ParsedList<T> = {
  items: T[];
  trivia?: ListTrivia[];
};
```

In `lib/types/typeHints.ts`, import `ListTrivia` and replace the parallel object
type declaration with:

```ts
export type ObjectTypeTrivia = ListTrivia;
```

Do not add `placement: "before"` when parsing existing trivia.

- [ ] **Step 4: Extend parse-time entries and partitioning**

In `lib/parsers/parsers.ts`, use these entry shapes:

```ts
type ItemEntry<T> = {
  kind: "item";
  item: T;
  trailingComment?: LineComment;
};

type TriviaEntry = {
  kind: "trivia";
  node: TriviaNode;
};

type InterleavedEntry<T> = ItemEntry<T> | TriviaEntry;
```

Replace `partitionTrivia` with:

```ts
function partitionTrivia<T>(entries: InterleavedEntry<T>[]): ParsedList<T> {
  const items: T[] = [];
  const trivia: ListTrivia[] = [];
  let pending: TriviaNode[] = [];

  for (const entry of entries) {
    if (entry.kind === "trivia") {
      pending.push(entry.node);
      continue;
    }

    if (pending.length > 0) {
      trivia.push({ anchorIndex: items.length, comments: pending });
      pending = [];
    }

    items.push(entry.item);
    if (entry.trailingComment) {
      trivia.push({
        anchorIndex: items.length - 1,
        placement: "trailing",
        comments: [entry.trailingComment],
      });
    }
  }

  if (pending.length > 0) {
    trivia.push({ anchorIndex: items.length, comments: pending });
  }

  return trivia.length > 0 ? { items, trivia } : { items };
}
```

- [ ] **Step 5: Encapsulate separator-specific item parsing**

Keep `literalDelimiter`'s missing-comma lookahead intact. Replace `itemEntry`
with a decorator that inspects the complete item-plus-delimiter span and parses
a comment only when that span did not cross a line. First define one entry
parser that consumes both exact comment text and its terminating layout:

```ts
const trailingLineCommentEntry: Parser<LineComment> = map(
  seqC(
    capture(lineCommentCore, "comment"),
    optionalSpacesOrNewline,
  ),
  (result) => result.comment,
);
```

Then add:

```ts
function itemEntryAfterDelimiter<T>(
  itemParser: Parser<T>,
  delimiter: Parser<unknown>,
): Parser<ItemEntry<T>> {
  return (input: string) => {
    const item = itemParser(input);
    if (!item.success) {
      return item as ParserResult<ItemEntry<T>>;
    }

    const separated = delimiter(item.rest);
    if (!separated.success) {
      return separated as ParserResult<ItemEntry<T>>;
    }

    if (consumedLineEnding(input, separated.rest)) {
      return success({ kind: "item", item: item.result }, separated.rest);
    }

    const comment = seqR(
      optionalSpaces,
      trailingLineCommentEntry,
    )(separated.rest);
    if (!comment.success) {
      return success({ kind: "item", item: item.result }, separated.rest);
    }

    return success(
      {
        kind: "item",
        item: item.result,
        trailingComment: comment.result,
      },
      comment.rest,
    );
  };
}
```

For object-type properties, newline itself is a legal delimiter. The parser must
accept both `property // comment` before a newline delimiter and
`property, // comment` after a punctuation delimiter. Add the separate policy:

```ts
function objectMemberEntry<T>(
  itemParser: Parser<T>,
  delimiter: Parser<unknown>,
): Parser<ItemEntry<T>> {
  return (input: string) => {
    const item = itemParser(input);
    if (!item.success) {
      return item as ParserResult<ItemEntry<T>>;
    }

    const beforeDelimiterComment = seqR(
      optionalSpaces,
      trailingLineCommentEntry,
    )(item.rest);
    if (beforeDelimiterComment.success) {
      const separated = delimiter(beforeDelimiterComment.rest);
      if (!separated.success) {
        return separated as ParserResult<ItemEntry<T>>;
      }
      return success(
        {
          kind: "item",
          item: item.result,
          trailingComment: beforeDelimiterComment.result,
        },
        separated.rest,
      );
    }

    const separated = delimiter(item.rest);
    if (!separated.success) {
      return separated as ParserResult<ItemEntry<T>>;
    }

    if (consumedLineEnding(input, separated.rest)) {
      return success({ kind: "item", item: item.result }, separated.rest);
    }

    const afterDelimiterComment = seqR(
      optionalSpaces,
      trailingLineCommentEntry,
    )(separated.rest);
    if (!afterDelimiterComment.success) {
      return success({ kind: "item", item: item.result }, separated.rest);
    }

    return success(
      {
        kind: "item",
        item: item.result,
        trailingComment: afterDelimiterComment.result,
      },
      afterDelimiterComment.rest,
    );
  };
}
```

Use `itemEntryAfterDelimiter` for arrays and object literals. Use
`objectMemberEntry` for object-type properties, passing the existing optional
object-property delimiter so an undelimited final member remains valid. Do not
replace the two delimiter parsers with a universal separator policy.

Add raw parser tests for a non-final trailing-comment item, a trailing comment
followed by standalone trivia, and a standalone comment after an item parser
that consumes its own newline. Assert item count, trivia placement, and the
following item—not only comment text—so parser progress and boundary detection
cannot regress unnoticed.

- [ ] **Step 6: Add shared trivia rendering**

Replace `emitTriviaAt` with helpers that process all records at an anchor:

```ts
protected renderTriviaNode(node: TriviaNode): string {
  if (node.type === "newLine") {
    return "";
  }
  if (node.type === "comment") {
    return this.processComment(node);
  }
  return this.processMultiLineComment(node);
}

protected beforeTriviaAt(
  trivia: ListTrivia[] | undefined,
  anchorIndex: number,
): TriviaNode[] {
  return (trivia ?? [])
    .filter(
      (entry) =>
        entry.anchorIndex === anchorIndex && entry.placement !== "trailing",
    )
    .flatMap((entry) => entry.comments);
}

protected trailingTriviaAt(
  trivia: ListTrivia[] | undefined,
  anchorIndex: number,
): LineComment[] {
  return (trivia ?? [])
    .filter(
      (entry) =>
        entry.anchorIndex === anchorIndex && entry.placement === "trailing",
    )
    .flatMap((entry) => entry.comments);
}
```

Add the multiline list renderer. Item-owned decorations are structured data,
not pre-indented multiline strings:

```ts
type RenderedListItem = {
  leadingLines?: string[];
  code: string;
};

type RenderListWithTriviaOptions<T> = {
  items: T[];
  trivia: ListTrivia[];
  prefix: string;
  open: string;
  close: string;
  suffix?: string;
  renderItem: (item: T, index: number) => RenderedListItem;
  separator: (index: number, itemCount: number) => string;
};

private renderListWithTrivia<T>(
  args: RenderListWithTriviaOptions<T>,
): string {
  this.increaseIndent();
  const lines: string[] = [];

  for (let index = 0; index < args.items.length; index++) {
    for (const triviaNode of this.beforeTriviaAt(args.trivia, index)) {
      lines.push(this.renderTriviaNode(triviaNode));
    }

    const item = args.renderItem(args.items[index], index);
    for (const leadingLine of item.leadingLines ?? []) {
      lines.push(this.indentStr(leadingLine));
    }
    const separator = args.separator(index, args.items.length);
    let line = this.indentStr(`${item.code}${separator}`);
    for (const comment of this.trailingTriviaAt(args.trivia, index)) {
      line = this.appendTrailingComment(line, comment);
    }
    lines.push(line);
  }

  for (const triviaNode of this.beforeTriviaAt(
    args.trivia,
    args.items.length,
  )) {
    lines.push(this.renderTriviaNode(triviaNode));
  }

  this.decreaseIndent();
  return `${args.prefix}${args.open}\n${lines.join("\n")}\n${this.indent()}${args.close}${args.suffix ?? ""}`;
}
```

Arrays, objects, and object types call this helper only when trivia exists.
Their no-trivia branches retain current behavior. Array/object separators are
commas except on the final item; object-type separators retain the current
canonical semicolon policy. Object-type `renderItem` returns formatted
`@validate`/`@jsonSchema` tags as `leadingLines` and the property as `code`, so
the shared renderer—not the caller—owns indentation. Add a tagged object-type
property with a trailing comment to the fixed-point matrix.

- [ ] **Step 7: Run compatibility, parser, and generator tests**

```bash
pnpm test:run lib/parsers/listTrailingComments.test.ts lib/parsers/dataStructures.test.ts lib/parsers/objectTypeTrivia.test.ts lib/parsers/literalDelimiter.test.ts lib/backends/agencyGenerator.test.ts lib/formatter.test.ts > /tmp/trailing-task3-green.txt 2>&1; echo $?
```

Expected: exit 0. In particular, existing trivia AST assertions remain
byte-for-byte unchanged and missing commas still fail.

- [ ] **Step 8: Commit**

Write `/tmp/trailing-task3-commit.txt`:

```text
parser: distinguish trailing list trivia

Unify list trivia placement while preserving existing AST shapes and separator
rules for arrays, objects, and object types.
```

Then run:

```bash
git add lib/types/dataStructures.ts lib/types/typeHints.ts lib/parsers/parsers.ts lib/backends/agencyGenerator.ts lib/parsers/listTrailingComments.test.ts lib/parsers/dataStructures.test.ts lib/parsers/objectTypeTrivia.test.ts lib/parsers/literalDelimiter.test.ts lib/backends/agencyGenerator.test.ts
git commit -F /tmp/trailing-task3-commit.txt
```

---

### Task 4: Function-call arguments and declaration parameters

**Files:**
- Modify: `lib/types/function.ts`
- Modify: `lib/types/graphNode.ts`
- Modify: `lib/types/access.ts`
- Modify: `lib/types/interruptStatement.ts`
- Modify: `lib/types/guardBlock.ts`
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/parsers/listTrailingComments.test.ts`
- Modify: `lib/parsers/function.test.ts`
- Modify: `lib/formatter.test.ts`

**Interfaces:**
- Consumes: `ListTrivia`, list parsing/partitioning, and list rendering from Task 3.
- Produces: `argumentTrivia` and `parameterTrivia` on their AST owners.
- Consumed by: Task 5's named-argument integrations.

- [ ] **Step 1: Write failing argument and parameter matrices**

Add to `lib/parsers/listTrailingComments.test.ts`:

```ts
describe("call and declaration list comments", () => {
  it.each([
    ["positional", `save(\n  first, // first\n  second // second\n)`],
    ["named", `save(\n  value: first, // value\n  retries: 3 // retries\n)`],
    ["splat", `save(\n  ...values, // values\n  final // final\n)`],
    ["method", `client.save(\n  first, // first\n  second // second\n)`],
    ["call chain", `handlers[0](\n  first, // first\n  second // second\n)`],
    ["interrupt", `interrupt io::read(\n  first, // first\n  second // second\n)`],
    ["raise", `raise io::failure(\n  first, // first\n  second // second\n)`],
  ])("preserves %s argument comments", (_name, call) => {
    const source = `node main() {\n  ${call}\n}\n`;
    const once = formatSource(source);
    expect(once).toContain("// first");
    expect(once).toContain("// second");
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });

  it.each([
    ["function", `def save(\n  value: string, // value\n  ...rest: string[] // rest\n) {\n}\n`],
    ["node", `node save(\n  value: string!, // value\n  retries: number = 3 // retries\n) {\n}\n`],
  ])("preserves %s parameter comments", (_name, source) => {
    const once = formatSource(source);
    expect(once).toContain("// value");
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });
});
```

Add a separate `guard(...) { ... }` case because its argument list is reshaped
into `GuardBlock` rather than `FunctionCall`. These cases pin every current
consumer of `argumentListParser`; do not assume changing that parser alone
preserves metadata through each consumer's AST construction and rendering.

- [ ] **Step 2: Run and save the red state**

```bash
pnpm test:run lib/parsers/listTrailingComments.test.ts lib/parsers/function.test.ts lib/formatter.test.ts > /tmp/trailing-task4-red.txt 2>&1; echo $?
```

Expected: exit 1 because these lists currently reject comments.

- [ ] **Step 3: Add explicit AST ownership fields**

Import `ListTrivia` into the relevant type files and add:

```ts
// FunctionCall
argumentTrivia?: ListTrivia[];

// FunctionDefinition
parameterTrivia?: ListTrivia[];

// GraphNodeDefinition
parameterTrivia?: ListTrivia[];

// InterruptStatement and GuardBlock
argumentTrivia?: ListTrivia[];

// AccessChainElement's `kind: "call"` variant
Pick<FunctionCall, "arguments" | "block" | "argumentTrivia">
```

Named fields avoid ambiguity on nodes that own more than one list.

- [ ] **Step 4: Add the policy-driven comma-list parser**

Extract the array/object `many(or(triviaEntry,
itemEntryAfterDelimiter(...)))` pattern without broadening any caller's
grammar:

```ts
type CommaListPolicy = {
  closer: string;
  cardinality: "zero-or-more" | "one-or-more";
  trailingComma: "allow" | "reject";
};

function commaDelimitedList<T>(
  itemParser: Parser<T>,
  policy: CommaListPolicy,
): Parser<ParsedList<T>> {
  const item = itemEntryAfterDelimiter(
    itemParser,
    commaListDelimiter(policy),
  );
  const entry = or(triviaEntry, item);
  const entries =
    policy.cardinality === "zero-or-more"
      ? many(entry)
      : map(
          seqC(
            capture(many(triviaEntry), "leading"),
            capture(item, "first"),
            capture(many(entry), "rest"),
          ),
          (result) => [
            ...result.leading,
            result.first,
            ...result.rest,
          ],
        );
  return map(
    entries,
    partitionTrivia,
  );
}
```

`commaListDelimiter` centralizes cursor mechanics but takes policy as data. Its
`allow` mode preserves `literalDelimiter`'s existing final-comma behavior. Its
`reject` mode still requires commas between items but fails when a comma is
followed only by trivia and the closer. Add named policy constants at call
sites instead of booleans whose meaning must be remembered.

Use it inside `argumentListParser`, `_baseFunctionParser`, and
`graphNodeParser`. Map `items` to the existing `arguments`/`parameters` fields
and set the named trivia field only when `parsedList.trivia` exists.

All three use `{ cardinality: "zero-or-more", trailingComma: "allow" }` with
the appropriate `)` closer, matching their current `sepBy` plus
`optional(comma)` grammar. The explicit policy is documentation and an
executable compatibility constraint, not new configurability for its own sake.

Inventory each migrated parser's current cardinality and trailing-comma rule
before selecting its policy. In particular, node imports and binding/match
patterns currently reject trailing commas, while literal lists allow them.
Add a negative compatibility test for every `reject` family. Object-type
members do not use this helper: their explicit policy allows punctuation or a
newline delimiter and permits the final member without a delimiter.

- [ ] **Step 5: Re-anchor trivia when extracting an inline block**

Add the pure helper:

```ts
function remapListTrivia(
  trivia: ListTrivia[] | undefined,
  canonicalSourceIndexes: number[],
): ListTrivia[] | undefined {
  if (!trivia) {
    return undefined;
  }

  const sourceItemCount = canonicalSourceIndexes.length;
  const sortedIndexes = [...canonicalSourceIndexes].sort((left, right) =>
    left - right,
  );
  const isPermutation = sortedIndexes.every(
    (sourceIndex, expectedIndex) => sourceIndex === expectedIndex,
  );
  if (!isPermutation) {
    throw new Error("canonical list order must contain every source item once");
  }

  const sourceToCanonical: (number | undefined)[] = [];
  canonicalSourceIndexes.forEach((sourceIndex, canonicalIndex) => {
    sourceToCanonical[sourceIndex] = canonicalIndex;
  });

  return trivia.map((entry) => {
    if (
      entry.placement !== "trailing" &&
      entry.anchorIndex === sourceItemCount
    ) {
      return { ...entry, anchorIndex: canonicalSourceIndexes.length };
    }
    const anchorIndex = sourceToCanonical[entry.anchorIndex];
    if (anchorIndex === undefined) {
      throw new Error(`list trivia has invalid source anchor ${entry.anchorIndex}`);
    }
    return {
      ...entry,
      anchorIndex,
    };
  });
}
```

Change inline-block extraction to retain each source index. After validation,
canonical order is every ordinary argument's source index followed by the
inline block's source index. Store remapped trivia on `FunctionCall`. A before
comment remains anchored to the source item it preceded; a trailing comment
moves with the source item. Preserve the existing one-inline-block and
block-conflict errors.

- [ ] **Step 6: Render call arguments and parameters through one list interface**

When no trivia exists, keep `wrapList` exactly as today. When trivia exists,
build the same virtual canonical list used by remapping, including the extracted
inline block:

```ts
type RenderArgumentItem =
  | FunctionCall["arguments"][number]
  | BlockArgument;

const items: RenderArgumentItem[] = inlineBlock
  ? [...node.arguments, inlineBlock]
  : node.arguments;

{
  items,
  trivia: node.argumentTrivia,
  prefix: `${asyncPrefix}${declaredName(node.functionName)}`,
  open: "(",
  close: ")",
  renderItem: (argument) => ({
    code: this.renderArgument(argument),
  }),
  separator: (index, count) => (index < count - 1 ? "," : ""),
}
```

Extract the existing named/splat/expression branch into `renderArgument` and
reuse it from `renderArgs`; include the current inline-lambda rendering in that
same helper. Do not duplicate argument or block rendering. The focused tests
must assert that the block itself remains present, is canonicalized last, and
each comment remains adjacent to its intended ordinary or block argument.

Pass `parameterTrivia` into `buildSignature`. With trivia, render parameters
through `renderListWithTrivia`; without trivia, keep the current `wrapList` call.
Both `processFunctionDefinition` and `processGraphNode` already use
`buildSignature`, so one integration covers both.

Propagate `argumentTrivia` through `_interruptExprParser`, every `raise` form,
`guardBlockParser`, and `callChainParser`. Route `processInterruptStatement`,
`processGuardBlock`, and the access-chain `kind: "call"` branch through the same
trivia-aware argument renderer. Method calls already contain a full
`FunctionCall`; direct call-chain elements need the widened `Pick` above.

- [ ] **Step 7: Add inline-block source-position cases**

Use canonical inline-block syntax from `lib/parsers/blockArgument.test.ts` to
test a block in first, middle, and last source position. Each case must include:

```ts
expect(once).toContain("// block");
expect(once).toContain("// ordinary");
expect(parseAgency(once as string, {}, false, false).success).toBe(true);
expect(formatSource(once as string)).toBe(once);
```

The canonical formatter may move the inline block last, but both comments must
move with the construct they described.

- [ ] **Step 8: Run call, signature, and formatter suites**

```bash
pnpm test:run lib/parsers/listTrailingComments.test.ts lib/parsers/function.test.ts lib/parsers/blockArgument.test.ts lib/parsers/access.test.ts lib/parsers/interruptStatement.test.ts lib/parsers/raiseStatement.test.ts lib/parsers/guardBlock.test.ts lib/formatter.test.ts lib/backends/agencyGenerator.test.ts > /tmp/trailing-task4-green.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 9: Commit**

Write `/tmp/trailing-task4-commit.txt`:

```text
fmt: preserve comments in calls and signatures

Carry trailing list trivia through calls, inline-block canonicalization, and
function and node parameter rendering.
```

Then run:

```bash
git add lib/types/function.ts lib/types/graphNode.ts lib/types/access.ts lib/types/interruptStatement.ts lib/types/guardBlock.ts lib/parsers/parsers.ts lib/backends/agencyGenerator.ts lib/parsers/listTrailingComments.test.ts lib/parsers/function.test.ts lib/formatter.test.ts
git commit -F /tmp/trailing-task4-commit.txt
```

---

### Task 5: Remaining multiline surfaces

**Files:**
- Modify: `lib/types/importStatement.ts`
- Modify: `lib/types/exportFromStatement.ts`
- Modify: `lib/types/pattern.ts`
- Modify: `lib/types/messageThread.ts`
- Modify: `lib/types/parallelBlock.ts`
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/parsers/listTrailingComments.test.ts`
- Modify: focused import/export/pattern/thread/parallel tests

**Interfaces:**
- Consumes: `ListTrivia`, `commaDelimitedList`, `remapListTrivia`, and
  `renderListWithTrivia`.
- Produces: complete support for every currently multiline list surface.

- [ ] **Step 1: Write the remaining syntax matrix before production changes**

Add canonical parse/format/fixed-point cases for:

```agency
import {
  alpha, // alpha
  beta // beta
} from "./tools"

import node {
  first, // first
  second // second
} from "./nodes.agency"

export {
  alpha, // alpha
  beta // beta
} from "./tools"

node main() {
  const [
    first, // first
    second // second
  ] = values

  const {
    name, // name
    age // age
  } = user

  match (value) {
    [
      "ok", // tag
      result // payload
    ] => result
  }

  thread(
    label: "work", // label
    hidden: true // visibility
  ) {
  }

  parallel(
    shared: true // state mode
  ) {
  }
}
```

Each test must assert the comment remains on the intended item line, the output
reparses, and the second format is identical. Add a sorted-import case proving
both outer import comments and inner name comments move with the correct import.

- [ ] **Step 2: Run and save the red state**

```bash
pnpm test:run lib/parsers/listTrailingComments.test.ts lib/parsers/importStatement.test.ts lib/parsers/exportFromStatement.test.ts lib/parsers/pattern.test.ts lib/parsers/messageThread.test.ts lib/parsers/parallelBlock.test.ts lib/formatter.test.ts > /tmp/trailing-task5-red.txt 2>&1; echo $?
```

Expected: exit 1 in the new comment cases only. All named focused test files
exist in the current tree; keep this command concrete rather than substituting
an ad hoc suite during implementation.

- [ ] **Step 3: Add named trivia ownership fields**

Import `ListTrivia` and add:

```ts
// NamedImport
nameTrivia?: ListTrivia[];

// ImportNodeStatement
nodeTrivia?: ListTrivia[];

// NamedExportBody
nameTrivia?: ListTrivia[];

// ArrayPattern
elementTrivia?: ListTrivia[];

// ObjectPattern
propertyTrivia?: ListTrivia[];

// MessageThread
argumentTrivia?: ListTrivia[];

// ParallelBlock
argumentTrivia?: ListTrivia[];
```

Do not put a generic `trivia` field on owners that may acquire another list;
the field name must identify the list.

- [ ] **Step 4: Replace multiline `sepBy` sites with `commaDelimitedList`**

Integrate the shared parser in:

- `namedImportParser` and `importNodeStatmentParser`;
- `namedExportBodyParser`;
- array/object binding patterns;
- array/object match patterns;
- `_threadNamedArgsParser`;
- `_parallelNamedArgsParser`.

For each parser, map `items` to the existing semantic field and set its named
trivia field only when trivia exists. Preserve marker/alias extraction,
rest-pattern validation, thread allowlists, duplicate checking, and
continue/session mutual exclusion exactly as they are today.

Use `one-or-more` for named imports, node imports, and named exports; use
`zero-or-more` for patterns and named argument lists that currently admit an
empty list. Select `allow` or `reject` only after reading each existing
`optional(comma)`/`sepBy` site, and pin every `reject` choice with a negative
trailing-comma test. This table-driven inventory prevents reuse from becoming
an accidental syntax expansion.

- [ ] **Step 5: Re-anchor thread arguments into canonical order**

Thread rendering uses the fixed order:

```ts
const THREAD_ARGUMENT_ORDER = [
  "label",
  "summarize",
  "continue",
  "session",
  "hidden",
];
```

After parsing and validation, compute each present canonical argument's source
index, call `remapListTrivia`, and store the result as `argumentTrivia` while
continuing to store semantic values in their existing fields. `parallel` has
only `shared`, so no reorder is necessary.

- [ ] **Step 6: Render all remaining lists through the shared helper**

Use `renderListWithTrivia` only when the named trivia field exists; retain every
current no-trivia path. Specifically:

- named imports/exports and node imports render comma-separated names;
- pattern formatters render their current item text and delimiters;
- thread rendering builds canonical named-argument strings in
  `THREAD_ARGUMENT_ORDER` and passes the remapped trivia;
- parallel rendering passes its single `shared` argument and trivia.

Use existing item-formatting helpers (`prefixMarkedName`, `formatPattern`, and
argument expression rendering). Do not duplicate marker, alias, or pattern
formatting inside the trivia renderer.

- [ ] **Step 7: Run all focused suites**

```bash
pnpm test:run lib/parsers/listTrailingComments.test.ts lib/parsers lib/backends/agencyGenerator.test.ts lib/formatter.test.ts > /tmp/trailing-task5-green.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 8: Commit**

Write `/tmp/trailing-task5-commit.txt`:

```text
fmt: support trailing comments in multiline lists

Apply shared list trivia to imports, exports, patterns, thread arguments, and
parallel arguments so every currently multiline surface follows one rule.
```

Then run:

```bash
git add lib/types/importStatement.ts lib/types/exportFromStatement.ts lib/types/pattern.ts lib/types/messageThread.ts lib/types/parallelBlock.ts lib/parsers/parsers.ts lib/backends/agencyGenerator.ts lib/parsers/listTrailingComments.test.ts lib/parsers lib/formatter.test.ts
git commit -F /tmp/trailing-task5-commit.txt
```

---

### Task 6: Documentation and compatibility gate

**Files:**
- Modify: `docs/site/guide/basic-syntax.md`
- Modify: any focused tests needed by failures found below

**Interfaces:**
- Consumes: all production behavior from Tasks 1–5.
- Produces: documented user rule and release-ready verification evidence.

- [ ] **Step 1: Replace the obsolete guide prohibition**

Replace the passage that says comments must be on their own line with:

````markdown
> A `//` comment can follow a complete declaration, statement, match arm, or
> item in a multiline list. `agency fmt` keeps it attached to that construct.
> In comma-separated lists, put the comma before the comment:

```agency
type UserId = string // stable identifier

node main() {
  save(
    userId, // user to save
    retries: 3 // retry budget
  )
}
```

Block comments and comments inside an unfinished expression are not trailing
comments. Lists whose Agency syntax is inline-only, such as tag arguments and
generic parameters, still do not accept line comments between items.
````

- [ ] **Step 2: Run the complete typecheck and structural lint**

```bash
pnpm run typecheck > /tmp/trailing-typecheck.txt 2>&1; echo "typecheck: $?"
pnpm run lint:structure > /tmp/trailing-lint.txt 2>&1; echo "lint: $?"
```

Expected: both exit 0.

- [ ] **Step 3: Build before broad tests**

```bash
make > /tmp/trailing-build.txt 2>&1; echo "build: $?"
```

Expected: exit 0. This also compiles the standard library and examples through
the changed parser.

- [ ] **Step 4: Run the full unit suite once**

```bash
pnpm test:run > /tmp/trailing-full.txt 2>&1; echo "unit: $?"
grep -E 'Tests |Test Files' /tmp/trailing-full.txt | tail -2
```

Expected: exit 0 with no failed test files.

- [ ] **Step 5: Run the formatter and location-sensitive suites**

```bash
pnpm test:run lib/formatter.test.ts lib/parser.test.ts lib/parsers/matchBlock.test.ts lib/linter/rules lib/lsp/foldingRange.test.ts lib/lsp/diagnostics.test.ts lib/lsp/formatting.test.ts > /tmp/trailing-locations.txt 2>&1; echo $?
```

Expected: exit 0. Do not create or invoke the nonexistent
`lib/parsers/locations.test.ts`. If a location-sensitive test fails, preserve
the owner's existing range and fix the consumer/attachment boundary; do not
extend `loc.end` through the comment.

- [ ] **Step 6: Run parser performance through the package script**

```bash
pnpm run test:perf > /tmp/trailing-perf.txt 2>&1; echo $?
```

Expected: exit 0. Record the test count and timing in the PR description.

- [ ] **Step 7: Audit anti-patterns explicitly**

Read `docs/dev/anti-patterns.md` and confirm from the diff:

- `completeConstructEntry` is used by top-level, body, and match-arm streams;
- `consumedLineEnding` is the single owner of consumed-source boundary checks;
- list parsing exposes `ParsedList<T>` rather than duplicating imperative loops;
- separator policies remain separate and named;
- `commentText` is the only line-comment text renderer;
- no branch checks `.success` for `many(...)`/`optionalSpaces`, which always
  succeed;
- no “harmless” duplicate whitespace consumption remains;
- no one-line `if` statements or nested ternaries were introduced;
- no wrapper node, inline duplicated comment type, `Map`, or `Set` was added.

- [ ] **Step 8: Commit docs and verification follow-ups**

Write `/tmp/trailing-task6-commit.txt`:

```text
docs: explain language-wide trailing comments

Document the complete-construct and multiline-list rule and record the final
compatibility, location, lint, unit, and performance checks.
```

Then run:

```bash
git add docs/site/guide/basic-syntax.md lib
git commit -F /tmp/trailing-task6-commit.txt
```

---

## Final review checklist

- [ ] Every supported position in the design spec has a positive canonical
  output test and fixed-point assertion.
- [ ] Every principled exclusion remains either inline-only or explicitly
  rejected; no arbitrary body-versus-top-level rule remains.
- [ ] Standalone comments never attach across a consumed newline.
- [ ] Sorted imports retain both outer and inner comments.
- [ ] Inline blocks retain comments through canonical reordering.
- [ ] Existing before-trivia AST snapshots are unchanged.
- [ ] Required commas remain required.
- [ ] Owner locations exclude attached comments.
- [ ] The TypeScript generator and handler infrastructure are unchanged except
  for accepting ignored optional formatter metadata.
- [ ] Full typecheck, build, unit, formatter, LSP/linter location, structural
  lint, and performance commands have fresh successful output saved under
  `/tmp`.
