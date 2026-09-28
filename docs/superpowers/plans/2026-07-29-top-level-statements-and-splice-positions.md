# Top-level statements and splice positions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the compiler one answer to "may this statement sit at the top level of a file?", so a top-level `if` reports a diagnostic instead of crashing, and so splices can put statements where they belong and nowhere else.

**Architecture:** One predicate, exhaustive over the node type, with two consumers. The type checker reports it as a diagnostic; a pre-pass in the builder guarantees no codegen path can reach the crash. The splice checker then calls the same predicate, so generated code is held to the standard written code is held to, by construction rather than by two lists agreeing.

**Tech Stack:** TypeScript, vitest, the existing type checker and TypeScript builder.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-29-top-level-statements-and-splice-positions-design.md`
**Review of that spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-29-top-level-statements-and-splice-positions-design-REVIEW.md`

## Global Constraints

- **Never commit to `main`.** Task 0 creates the branch. Check `git branch --show-current` before every commit.
- **The predicate is the only place the rule lives.** No consumer may add its own list, and no consumer may special-case around it. Two lists is the bug being fixed.
- **`make` before claiming anything works.** vitest does not typecheck — a green suite says nothing about whether the branch compiles. Execution fixtures run through `dist/`, so `make` must also be re-run after every code change before running one.
- **"Expected FAIL, observed PASS" is a stop condition.** Every run-to-fail step exists to prove the test is not vacuous.
- **Do not widen the refusal beyond what the spec lists.** Several node types compile at the top level today and are meaningless there; the spec keeps them. Refusing them is a separate decision, not a tidy-up.
- Unit tests: `pnpm test:run <path>`. Execution fixtures: `pnpm run a test <path>`. Do not run the full agency suite locally.

---

# Background

## The crash

```ts
if (true) { print(1) }

node main() { print(2) }
```

```
Error: StepPathTracker: currentId() called with empty path
    at TypeScriptBuilder.processIfElseWithSteps
    at TypeScriptBuilder.processNode
    at TypeScriptBuilder.processNodeInGlobalInit
    at partitionProgram
```

No file, no line, no column. Issue **#713**.

Two decisions combine. The top-level grammar (`nodeParser`, `lib/parser.ts:75`) accepts `ifParser`, `forLoopParser`, `whileLoopParser`, `matchBlockParser`, `messageThreadParser` and `handleBlockParser`. And the builder routes anything not in `TOP_LEVEL_DECLARATION_TYPES` (`lib/backends/typescriptBuilder/nameClassifier.ts:25`) into the per-execution `__initializeGlobals` body, where the step machinery has no step path to hand out.

**That set answers a different question** — where a node is *emitted* — and must not become the answer to whether it is *legal*.

## The rule

Top-level code is **initialization, not execution**. It runs in the init phases, which have no step machinery and no control flow. A top-level statement may *establish* something — bind a name, call something for its effect — but may not *control* anything.

## The two splice bugs, same root

A splice records its position, and there are only two (`lib/types/splice.ts:20`):

```ts
position: "decl" | "expr";
```

`spliceRest` stamps `"expr"` (`parsers.ts:3251`); `topLevelSpliceParser` rewrites it to `"decl"`. A splice occupying a whole statement in a body has its own alternative in `_bodyNodeParser` but nothing rewrites its position, so it stays `"expr"`.

So statements are **refused where they are useful** (a body splice gets AG8007), and **accepted where they break** — `KINDS_FOR_POSITION.decl` has `"statements"` appended (`expandSplices.ts:465`), and a statements fragment at the top level emits TypeScript that esbuild cannot parse.

## The measured table

Every row run on `main`, at the top level of a file above an ordinary `node main()`:

| Written at the top level | Result |
| --- | --- |
| `if`, `while`, `for`, `match`, `thread` | **crash** |
| `handle { … } with (e) { … }` | **crash** |
| `debugger("x")` (the parenthesized form) | **crash** |
| `guard`, `try`, `handle read(p) { … }` | parse error |
| `interrupt("x")`, `static interrupt("x")` | compiles, **crashes at run time** (`__self is not defined`) |
| `return 1`, `goto other` | compiles |
| `debugger`, `someName`, `print(1)`, `foo.bar`, `x = 1`, `const y = 2` | compiles |
| `static print(1)`, `skill "x"`, `@tag(1)` | compiles |
| `1 + 2`, `true`, `null` | compiles |
| `"hello"`, `42`, `5s`, `"""hi"""`, `re/ab/`, `[1, 2]`, `{ a: 1 }` | parse error |

Two rows are easy to misread. Bare `debugger` **compiles** — it parses as a
name, not as a debugger statement, because `debuggerParser` requires
parentheses. The parenthesized `debugger("x")` is the real
`debuggerStatement` node and it **crashes**, so the two spellings land on
opposite sides of the rule.

And the literal forms are uneven: `true` and `null` compile at file scope
while `42` and `"hello"` are parse errors. That is the grammar's shape, not a
principle — which is why the table below follows the measurements rather than
tidying them.

---

# File structure

| File | Responsibility |
| --- | --- |
| `lib/utils/topLevel.ts` | **New.** `isLegalAtTopLevel`, exhaustive over `AgencyNode["type"]`. |
| `lib/utils/topLevel.test.ts` | **New.** The rule as a test, plus the placement-set tie. |
| `lib/typeChecker/topLevelStatements.ts` | **New.** The `AG3017` diagnostic pass. |
| `lib/typeChecker/index.ts` | Wire the pass in, next to `checkTemplateHoles`. |
| `lib/typeChecker/diagnostics.ts` | The `AG3017` entry. |
| `lib/typeChecker/diagnosticExplanations.ts` | Its `agency explain` prose (exhaustive by type — a new code without prose is a compile error). |
| `lib/backends/typescriptBuilder.ts` | Pre-pass in `build()`, next to the unfilled-holes refusal. (Grepping for "AG8001" there finds nothing — the literal lives in `DIAGNOSTICS.unfilledHoles`.) |
| `lib/backends/typescriptBuilder/nameClassifier.ts` | Export `TOP_LEVEL_DECLARATION_TYPES` so the triangle test reads it rather than copying it. |
| `lib/types/splice.ts` | Widen `position` to include `"statement"`. |
| `lib/parsers/parsers.ts` | Stamp `"statement"` on the body-level splice alternative. |
| `lib/preprocessors/expandSplices.ts` | The new position's kinds; the decl check calls the predicate; exhaustive message building. |
| `tests/agency/templates/spliceInBody.agency` + `.test.json` | End-to-end fixture from the original report. |

---

### Task 0: Branch

- [ ] **Step 1: Create a worktree and branch**

Worktrees go inside the `agency-lang` directory, never the home directory.

```bash
cd /Users/adityabhargava/agency-lang
git worktree add worktree-top-level -b adit/top-level-statements origin/main
cd worktree-top-level && pnpm install
git branch --show-current
```

Expected: `adit/top-level-statements`. All later paths are relative to `worktree-top-level/packages/agency-lang`.

---

### Task 1: The predicate

**Files:**
- Create: `lib/utils/topLevel.ts`, `lib/utils/topLevel.test.ts`

**Interfaces:**
- Consumes: `AgencyNode` from `../types.js`.
- Produces: `isLegalAtTopLevel(node: AgencyNode): boolean`. Tasks 2 and 4 both call it.

- [ ] **Step 1: Write the failing test**

The test is the rule, so it should read like the rule.

```ts
import { describe, it, expect } from "vitest";
import { isLegalAtTopLevel } from "./topLevel.js";
import { parseAgency } from "../parser.js";
import type { AgencyNode } from "../types.js";

/** The first non-trivia node of a program parsed from `source`. */
function firstNode(source: string): AgencyNode {
  const result = parseAgency(source, {}, false);
  if (!result.success) throw new Error(`${source}: ${result.message}`);
  // Skip trivia only. NOT importStatement — one allowed case IS an import.
  const node = result.result.nodes.find(
    (n) => n.type !== "newLine" && n.type !== "comment",
  );
  if (!node) throw new Error(`no node in: ${source}`);
  return node;
}

describe("isLegalAtTopLevel: allowed", () => {
  // Top-level code is initialization. It may ESTABLISH something.
  const allowed: string[] = [
    "node main() { print(1) }",
    "def helper(): number { return 1 }",
    "type Person = { name: string }",
    'import { read } from "std::fs"',
    "const x = 1",
    "let y = 2",
    "static const z = 3",
    "x = 1",
    "print(1)",
    "foo.bar",
    "static print(1)",
    'skill "x"',
    "@tag(1)",
    "debugger",       // parses as a variableName, not a debuggerStatement
    "someName",
    "1 + 2",
    "true",
    "null",
  ];

  for (const source of allowed) {
    it(`allows: ${source}`, () => {
      expect(isLegalAtTopLevel(firstNode(source)), source).toBe(true);
    });
  }
});

describe("isLegalAtTopLevel: refused", () => {
  // It may not CONTROL anything: the init phases have no step machinery.
  const refused: string[] = [
    "if (true) { print(1) }",
    "while (false) { print(1) }",
    "for (x in [1, 2]) { print(x) }",
    "match(1) { 1 => print(1) }",
    "thread { print(1) }",
    "handle {\n  print(1)\n} with (e) {\n  return approve()\n}",
    "return 1",
    "goto other",
    'interrupt("x")',
    'static interrupt("x")',
    // The parenthesized form, which is a real debuggerStatement and
    // crashes today — the opposite side of the rule from bare `debugger`.
    'debugger("x")',
  ];

  for (const source of refused) {
    it(`refuses: ${source.split("\n")[0]}`, () => {
      expect(isLegalAtTopLevel(firstNode(source)), source).toBe(false);
    });
  }
});

describe("isLegalAtTopLevel: body-only forms", () => {
  // These cannot be parsed at the top level, so no whole-file test can
  // reach them — but a statements FRAGMENT parses body grammar, so Task 4
  // splices them straight at the per-node check. Pull them out of a body
  // parse to exercise the table rows that path depends on.
  function firstBodyNode(body: string): AgencyNode {
    const node = firstNode(`node m() {\n${body}\n}\n`) as { body?: AgencyNode[] };
    const inner = node.body?.[0];
    if (!inner) throw new Error(`no body node in: ${body}`);
    return inner;
  }

  const refused: [string, string][] = [
    ["guard", "  guard {\n    print(1)\n  }"],
    ["try", "  try {\n    print(1)\n  } catch {\n    print(2)\n  }"],
    ["finalize", "  finalize {\n    print(1)\n  }"],
  ];

  for (const [label, body] of refused) {
    it(`refuses a ${label} block`, () => {
      expect(isLegalAtTopLevel(firstBodyNode(body)), label).toBe(false);
    });
  }
});

describe("isLegalAtTopLevel: static wraps its inner statement", () => {
  it("judges the statement inside, not the `static`", () => {
    expect(isLegalAtTopLevel(firstNode("static print(1)"))).toBe(true);
    expect(isLegalAtTopLevel(firstNode('static interrupt("x")'))).toBe(false);
  });
});

describe("placement can never route an illegal node", () => {
  // Three things describe the top level after this change: the grammar
  // (permissive), the placement set (where a node is emitted), and this
  // predicate (whether it may be there). This closes the triangle.
  it("every top-level declaration type is legal at the top level", () => {
    // Reads the REAL set, never a copy — a copy is exactly what this test
    // exists to prevent. `TOP_LEVEL_DECLARATION_TYPES` is module-private
    // today, so export it (or a read-only accessor) from
    // `lib/backends/typescriptBuilder/nameClassifier.ts` as part of this
    // task. One line of API; without it the triangle does not close.
    for (const type of TOP_LEVEL_DECLARATION_TYPES) {
      expect(isLegalAtTopLevel({ type } as AgencyNode), type).toBe(true);
    }
  });

  it("a static assignment is legal too", () => {
    // The placement set's other half: `isTopLevelDeclaration` special-cases
    // a static-scoped assignment (`nameClassifier.ts:105-109`).
    expect(isLegalAtTopLevel({ type: "assignment" } as AgencyNode)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test:run lib/utils/topLevel.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Write the predicate**

Create `lib/utils/topLevel.ts`. The table is a `Record<AgencyNode["type"], boolean>`, so adding a node kind to the language fails to compile until it is classified — the same enforcement `identifierSlots.ts` uses, and for a sharper reason: the failure being fixed is "a statement form nobody considered reached the backend and crashed it".

```ts
import type { AgencyNode } from "../types.js";
import type { StaticStatement } from "../types.js";

/**
 * May this node sit at the top level of a file?
 *
 * Top-level code is initialization, not execution: it runs in the init
 * phases, which have no step machinery. So a node may ESTABLISH something
 * — bind a name, call for effect — but may not CONTROL anything.
 *
 * The `Record<AgencyNode["type"], …>` is the point: a new node kind fails
 * to compile until someone decides. The bug this exists to stop is a
 * statement form nobody considered reaching the backend and crashing it.
 *
 * Answers legality only. Where a node is EMITTED is a different question,
 * owned by `TOP_LEVEL_DECLARATION_TYPES` in the builder.
 */
const LEGAL_AT_TOP_LEVEL: Record<AgencyNode["type"], boolean> = {
  // Declarations.
  graphNode: true,
  function: true,
  typeAlias: true,
  effectDeclaration: true,
  importStatement: true,
  importNodeStatement: true,
  exportFromStatement: true,
  skill: true,
  tag: true,

  // Bindings and expression statements.
  assignment: true,
  functionCall: true,
  valueAccess: true,
  binOpExpression: true,
  keyword: true,

  // `static <inner>` — judged by its inner statement, see below.
  staticStatement: true,

  // Literal forms, which the top-level grammar accepts unevenly. These
  // follow the measurements, not a principle: refusing what compiles
  // today would be a breaking change nobody asked for.
  variableName: true,   // bare `debugger` is one of these
  boolean: true,
  null: true,
  number: false,        // parse error at top level
  string: false,        // parse error
  multiLineString: false,
  unitLiteral: false,
  regex: false,

  // `debugger(...)` — the parenthesized form. Crashes today, unlike the
  // bare word above, which is a `variableName`.
  debuggerStatement: false,

  // Trivia.
  comment: true,
  multiLineComment: true,
  newLine: true,

  // Control flow: the init phases cannot branch, loop, or wait.
  ifElse: false,
  whileLoop: false,
  forLoop: false,
  matchBlock: false,
  matchYield: false,
  messageThread: false,
  handleBlock: false,
  finalizeBlock: false,
  guardBlock: false,
  parallelBlock: false,
  seqBlock: false,
  tryExpression: false,
  withModifier: false,

  // Node-relative: there is no enclosing node at file scope.
  returnStatement: false,
  gotoStatement: false,

  // Interrupts need a running node. Both spellings compile today and then
  // crash with `__self is not defined`; refusing is the better error.
  interruptStatement: false,

  // Sub-expressions and patterns. Not statements at all — the grammar
  // cannot produce most of them here, and `false` is the honest answer
  // for any that slip through.
  agencyObject: false,
  agencyArray: false,
  comprehension: false,
  newExpression: false,
  schemaExpression: false,
  isExpression: false,
  typeTestExpression: false,
  blockArgument: false,
  awaitPending: false,
  markDestructiveRan: false,
  rawCode: false,
  objectPattern: false,
  arrayPattern: false,
  restPattern: false,
  wildcardPattern: false,
  resultPattern: false,
  typePattern: false,

  // Templates. A hole is refused earlier (AG8001); a code literal is a
  // value, and a splice is replaced before this check runs.
  hole: false,
  codeLiteral: false,
  splice: false,
};

export function isLegalAtTopLevel(node: AgencyNode): boolean {
  // `static print(1)` is legal and `static interrupt(...)` is not, so the
  // wrapper defers to what it wraps.
  if (node.type === "staticStatement") {
    return isLegalAtTopLevel((node as StaticStatement).statement);
  }
  return LEGAL_AT_TOP_LEVEL[node.type];
}
```

Two things to know about the key set, both of which cost time if discovered
at the compiler:

- **`Literal` is itself a union.** It contributes seven type strings —
  `number`, `unitLiteral`, `string`, `multiLineString`, `variableName`,
  `boolean`, `null` (`lib/types/literals.ts:4-11`). There is no `"literal"`
  key. Each of the seven is above, set from the measured table.
- **`RegexLiteral`'s type string is `regex`**, not `regexLiteral`
  (`lib/types/literals.ts:95`).

If any other name does not match the union, fix it to match — do not add an
index signature or a `default`, which would destroy the enforcement this
table exists for. The union is at `lib/types.ts:336`.

The `staticStatement` unwrap has no `undefined` guard on purpose: the parser
cannot produce a `staticStatement` without an inner statement
(`parsers.ts:4560-4563`), so a guard would handle an impossible state — and
answering `true` for it would wave a malformed node toward the crash this
predicate exists to stop.

- [ ] **Step 4: Run the tests**

```bash
pnpm test:run lib/utils/topLevel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck, because vitest does not**

```bash
make
```

Expected: exit 0. A missing or misspelled key in the table is a compile error here and nowhere else.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must not be main
git add lib/utils/topLevel.ts lib/utils/topLevel.test.ts
git commit -F - <<'EOF'
feat: one predicate for what may sit at the top level of a file

Top-level code is initialization: it may establish something but not
control anything. The table is keyed by node type, so adding a node kind
to the language fails to compile until someone classifies it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: The diagnostic, and the guarantee

Two consumers with different jobs. The type checker gives the user a message with a location. The builder pre-pass guarantees no codegen path can reach the crash, whatever else changes.

**Files:**
- Create: `lib/typeChecker/topLevelStatements.ts`
- Modify: `lib/typeChecker/diagnostics.ts`, `lib/typeChecker/diagnosticExplanations.ts`, `lib/typeChecker/index.ts`, `lib/backends/typescriptBuilder.ts`
- Test: `lib/typeChecker/topLevelStatements.test.ts`

**Interfaces:**
- Consumes: `isLegalAtTopLevel` from Task 1.
- Produces: diagnostic `AG3017`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { typeCheck } from "./index.js";
import { parseAgency } from "../parser.js";

function check(source: string) {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error(parsed.message);
  return typeCheck(parsed.result, {});
}

describe("AG3017: statements that cannot sit at the top level", () => {
  const refused: [string, string][] = [
    ["if", "if (true) {\n  print(1)\n}\n\nnode main() { print(2) }\n"],
    ["while", "while (false) {\n  print(1)\n}\n\nnode main() { print(2) }\n"],
    ["for", "for (x in [1, 2]) {\n  print(x)\n}\n\nnode main() { print(2) }\n"],
    ["match", "match(1) {\n  1 => print(1)\n}\n\nnode main() { print(2) }\n"],
    ["thread", "thread {\n  print(1)\n}\n\nnode main() { print(2) }\n"],
    // The row the spec's first draft got wrong, and the one where a wrong
    // fix is worst: a handler that compiles and never registers.
    ["handle", "handle {\n  print(1)\n} with (e) {\n  return approve()\n}\n\nnode main() { print(2) }\n"],
    ["return", "return 1\n\nnode main() { print(2) }\n"],
    ["goto", "goto other\n\nnode main() { print(2) }\n"],
    ["interrupt", 'interrupt("x")\n\nnode main() { print(2) }\n'],
    ["static interrupt", 'static interrupt("x")\n\nnode main() { print(2) }\n'],
  ];

  for (const [label, source] of refused) {
    it(`refuses ${label} with a located diagnostic`, () => {
      const errors = check(source);
      // Handlers report AG3018; everything else AG3017.
      const expectedCode = label === "handle" ? "AG3018" : "AG3017";
      const found = errors.find((e) => e.code === expectedCode);
      expect(found, label).toBeDefined();
      expect(found?.loc, label).toBeTruthy();
    });
  }

  const allowed: [string, string][] = [
    ["const", "const x = 1\n\nnode main() { print(x) }\n"],
    ["bare call", "print(1)\n\nnode main() { print(2) }\n"],
    ["static call", "static print(1)\n\nnode main() { print(2) }\n"],
    ["assignment", "x = 1\n\nnode main() { print(2) }\n"],
    ["debugger", "debugger\n\nnode main() { print(2) }\n"],
    ["declarations", "def f(): number {\n  return 1\n}\n\nnode main() { print(2) }\n"],
  ];

  for (const [label, source] of allowed) {
    it(`allows ${label}`, () => {
      const codes = check(source).filter(
        (e) => e.code === "AG3017" || e.code === "AG3018",
      );
      expect(codes, label).toEqual([]);
    });
  }

  it("reports every offender, not just the first", () => {
    const two = "if (true) {\n  print(1)\n}\n\nif (false) {\n  print(2)\n}\n\nnode main() { print(3) }\n";
    expect(check(two).filter((e) => e.code === "AG3017")).toHaveLength(2);
  });

  it("names the rule, not just the symptom", () => {
    const errors = check("if (true) {\n  print(1)\n}\n\nnode main() { print(2) }\n");
    const found = errors.find((e) => e.code === "AG3017");
    expect(found?.message).toMatch(/top level/);
    expect(found?.message).toMatch(/initializ/i);
  });
});
```

The `typeCheck` signature and the error shape may differ from the sketch
above; match what the neighbouring checks' tests do rather than what is
written here, and keep the assertions.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/typeChecker/topLevelStatements.test.ts
```

Expected: the refusal tests FAIL (no such diagnostic yet); the allowed tests PASS.

- [ ] **Step 3: Add the diagnostic**

In `lib/typeChecker/diagnostics.ts`, next to its structural neighbours
(`AG3016` is the current highest in that range):

```ts
  topLevelStatementNotAllowed: {
    code: "AG3017",
    severity: "error",
    message:
      "A {kind} cannot sit at the top level of a file. Top-level code runs at " +
      "initialization, which cannot branch, loop, or wait — move it inside a node " +
      "or a function.",
  },
```

Handlers get their own wording AND their own code. No two entries in
`diagnostics.ts` share a code today, and `agency explain` looks up by code —
a collision would be the first, with nothing having had to handle it.
`AG3018` is free. It is also better for users: a handler at the top level is
a different mistake from an `if` at the top level and deserves its own
explain page.

```ts
  topLevelHandlerNotAllowed: {
    code: "AG3018",
    severity: "error",
    message:
      "A handler cannot be registered at the top level of a file. Handlers must be " +
      "inside a node or a function, where there is execution for them to guard.",
  },
```

Add prose for the code in `lib/typeChecker/diagnosticExplanations.ts` — that
file is exhaustive by type, so a new code without prose is a compile error.

- [ ] **Step 4: Write the pass**

Create `lib/typeChecker/topLevelStatements.ts`:

```ts
import { isLegalAtTopLevel } from "../utils/topLevel.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * AG3017 — the top-level rule, reported where the user can see it.
 *
 * Top level only: this walks `ctx.programNodes` directly rather than
 * recursing, because a node's own body is a different context entirely.
 */
export function checkTopLevelStatements(ctx: TypeCheckerContext): void {
  for (const node of ctx.programNodes) {
    if (isLegalAtTopLevel(node)) continue;
    // `static interrupt(...)` should say "interrupt", not "staticStatement":
    // the predicate defers to the inner node, so the message must too.
    const offender =
      node.type === "staticStatement"
        ? (node as StaticStatement).statement
        : node;
    const isHandler = offender.type === "handleBlock";
    ctx.errors.push(
      diagnostic(
        isHandler ? "topLevelHandlerNotAllowed" : "topLevelStatementNotAllowed",
        { kind: describeKind(offender.type) },
        node.loc ?? null,
      ),
    );
  }
}

/** `ifElse` reads as "if statement" to a user, not as a node type.
 *
 *  Before writing this: grep the diagnostics and explanations files for an
 *  existing type-to-display-name helper and use it if one exists. A second
 *  hand list is the thing this plan argues against everywhere else. If none
 *  exists, this is acceptable — an unmapped type falls back to its own
 *  name, so it fails ugly rather than wrong. */
function describeKind(type: string): string {
  const names: Record<string, string> = {
    ifElse: "`if` statement",
    whileLoop: "`while` loop",
    forLoop: "`for` loop",
    matchBlock: "`match` block",
    messageThread: "`thread` block",
    returnStatement: "`return`",
    gotoStatement: "`goto`",
    interruptStatement: "interrupt",
  };
  return Object.hasOwn(names, type) ? names[type] : `\`${type}\``;
}
```

Wire it in `lib/typeChecker/index.ts` next to `checkTemplateHoles` (around
line 369), with a one-line comment matching the style of its neighbours.

- [ ] **Step 5: Run the tests**

```bash
pnpm test:run lib/typeChecker/topLevelStatements.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add the builder pre-pass**

The type checker does not run on every path that reaches codegen, and the
crash is unacceptable regardless. Mirror the AG8001 hole refusal at the top
of `TypeScriptBuilder.build()` (`lib/backends/typescriptBuilder.ts:502`),
directly after it:

```ts
    // Same reasoning as the hole refusal above: refuse before generating
    // anything. Reaching processNodeInGlobalInit with a control-flow node
    // throws from inside the step machinery, with no location to report.
    const illegal = program.nodes.filter((node) => !isLegalAtTopLevel(node));
    if (illegal.length > 0) {
      // Same rendering path as the refusal above, ten lines up. Two shapes
      // for one operation, that close together, is the inconsistency the
      // catalog names.
      const rendered = renderMessage(DIAGNOSTICS.topLevelStatementNotAllowed.message, {
        kind: illegal.map((node) => node.type).join(", "),
      });
      throw new Error(
        `${DIAGNOSTICS.topLevelStatementNotAllowed.code}: ${rendered}`,
      );
    }
```

- [ ] **Step 6b: Test the pre-pass directly, because nothing else reaches it**

This is the only piece of the plan whose whole job is "whatever else
changes, the crash stays unreachable" — and it is the piece with no coverage
unless this step exists. `buildSession` runs `typeCheck` before building
(`lib/compiler/buildSession.ts:665`), so the checker's diagnostic fires
first and the CLI check in the next step never executes this throw. Delete
the pre-pass and every other test in this plan stays green, which is exactly
the drift it exists to prevent.

In `lib/backends/`, calling the builder directly with no type check in
front of it:

```ts
it("refuses a top-level statement before generating anything", () => {
  const parsed = parseAgency("if (true) {\n  print(1)\n}\n\nnode main() { print(2) }\n", {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const build = () => new TypeScriptBuilder(unitFor(parsed.result)).build(parsed.result);
  expect(build).toThrow(/AG3017/);
  // The point of the pre-pass: not this.
  expect(build).not.toThrow(/StepPathTracker/);
});
```

Match how the neighbouring builder tests construct a `TypeScriptBuilder` —
`lib/backends/holeRefusal.test.ts` does the same thing for the hole refusal
this pre-pass sits beside, and is the closest model.

- [ ] **Step 7: Confirm the crash is gone, by hand**

```bash
make
mkdir -p investigate
printf 'if (true) {\n  print(1)\n}\n\nnode main() { print(2) }\n' > investigate/t.agency
pnpm run agency compile investigate/t.agency
```

Expected: an `AG3017` diagnostic naming the file, line and column — not
`StepPathTracker: currentId() called with empty path`. This exercises the
type-checker path; Step 6b is what covers the builder pre-pass.

Repeat for the block-form `handle`, which is the case a wrong fix would turn
into a silently unregistered handler (expect `AG3018` here):

```bash
printf 'handle {\n  print(1)\n} with (e) {\n  return approve()\n}\n\nnode main() { print(2) }\n' > investigate/h.agency
pnpm run agency compile investigate/h.agency
rm -rf investigate
```

- [ ] **Step 8: Run the wider suites**

```bash
pnpm test:run lib/typeChecker/ lib/backends/ lib/utils/
```

Expected: PASS. A failure here is most likely a fixture that had a top-level
statement nobody noticed — read it before changing it. If a *legitimate*
form is now refused, fix the table, not the test.

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # must not be main
git add lib/typeChecker/ lib/backends/typescriptBuilder.ts
git commit -F - <<'EOF'
fix: top-level control flow reports AG3017 instead of crashing

`if` at file scope routed into __initializeGlobals and threw from inside
the step machinery, with no file, line or column. Report it in the type
checker, and refuse it in a builder pre-pass so no codegen path can
reach the crash.

Handlers get their own wording: a top-level `handle` is a handler its
author believes is registered.

Closes #713.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: A splice inside a body is in statement position

**Files:**
- Modify: `lib/types/splice.ts`, `lib/parsers/parsers.ts`, `lib/preprocessors/expandSplices.ts`
- Test: `lib/preprocessors/expandSplices.test.ts`, `lib/parsers/splice.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/parsers/splice.test.ts`, that a body splice is stamped:

```ts
it("stamps statement position on a splice occupying a whole statement", () => {
  const parsed = parseAgency("node main() {\n  $( gen() )\n}\n", {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const splice = [...walkNodesArray(parsed.result.nodes)]
    .map((v) => v.node)
    .find((n) => n.type === "splice") as { position?: string };
  expect(splice?.position).toBe("statement");
});

it("still stamps decl on a top-level splice", () => {
  // The new wrapper must not disturb the position it sits beside.
  const parsed = parseAgency("$( gen() )\n\nnode main() { print(1) }\n", {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const splice = [...walkNodesArray(parsed.result.nodes)]
    .map((v) => v.node)
    .find((n) => n.type === "splice") as { position?: string };
  expect(splice?.position).toBe("decl");
});

it("leaves a splice in an expression alone", () => {
  const parsed = parseAgency("node main() {\n  const x = $( gen() )\n}\n", {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const splice = [...walkNodesArray(parsed.result.nodes)]
    .map((v) => v.node)
    .find((n) => n.type === "splice") as { position?: string };
  expect(splice?.position).toBe("expr");
});
```

In `lib/preprocessors/expandSplices.test.ts`, that statement position accepts
statements, following that file's existing conventions for standing up a
generator:

- a generator returning a `statements` fragment expands in a body
- a generator returning an `expr` fragment still expands in a body
- a multi-statement generator spreads into the body rather than producing one node
- a kind mismatch in statement position produces a message that says
  **statement** position, not expression position

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/parsers/splice.test.ts lib/preprocessors/expandSplices.test.ts
```

Expected: the new tests FAIL; everything already there PASSES.

- [ ] **Step 3: Widen the position**

`lib/types/splice.ts`:

```ts
  position: "decl" | "statement" | "expr";
```

- [ ] **Step 4: Stamp it**

In `lib/parsers/parsers.ts`, the body-level splice alternative in
`_bodyNodeParser` currently registers `lazy(() => spliceParser)` and inherits
`"expr"`. Wrap it the way `topLevelSpliceParser` wraps for `"decl"`:

```ts
/** A splice occupying a whole statement in a body. Same parser as the
 *  expression form; this exists solely to stamp `position: "statement"`,
 *  which is what lets a generator return statements here. */
const statementSpliceParser: Parser<Splice> = map(
  lazy(() => spliceParser),
  (splice) => ({ ...splice, position: "statement" as const }),
);
```

and register `statementSpliceParser` where `lazy(() => spliceParser)` sits
today. Update the comment there, which currently says position stays `"expr"`.

- [ ] **Step 5: Give the position its kinds**

In `lib/preprocessors/expandSplices.ts`:

```ts
const KINDS_FOR_POSITION: Record<Splice["position"], string[]> = {
  decl: [...KINDS_FOR_SORT.decl, "statements"],
  statement: KINDS_FOR_SORT.statements,
  expr: KINDS_FOR_SORT.expr,
};
```

`KINDS_FOR_SORT.statements` is already `["statements", "program", "expr"]` —
the same set a statements *hole* accepts, right for the same reason.

- [ ] **Step 6: Make the message exhaustive**

Two lines below the lookup (`expandSplices.ts:556-557`) the message is built
with binary ternaries on `position`. A third value passes through them
silently and describes a statement mismatch as "expression position needs an
expr fragment" — the exact confusion this task removes. Replace with
exhaustive switches:

```ts
function expectedKindFor(position: Splice["position"]): string {
  switch (position) {
    case "decl": return "program";
    case "statement": return "statements";
    case "expr": return "expr";
  }
}

function positionLabel(position: Splice["position"]): string {
  switch (position) {
    case "decl": return "declaration";
    case "statement": return "statement";
    case "expr": return "expression";
  }
}
```

No `default` — the compiler should notice the next position, not a reader.

- [ ] **Step 7: Run the tests, then the suites**

```bash
pnpm test:run lib/parsers/ lib/preprocessors/
make
```

Expected: PASS, and `make` exits 0.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must not be main
git add lib/types/splice.ts lib/parsers/ lib/preprocessors/
git commit -F - <<'EOF'
feat: a splice inside a body is in statement position

A splice occupying a whole statement inherited `position: "expr"`, so a
generator returning statements was refused in the one place it is most
useful. Stamp "statement" and map it to the kinds a statements hole
already accepts.

The mismatch message is now built by exhaustive switch, so a future
position cannot be described as an expression by default.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: A top-level splice is held to the top-level rule

**Files:**
- Modify: `lib/preprocessors/expandSplices.ts`
- Test: `lib/preprocessors/expandSplices.test.ts`

- [ ] **Step 1: Write the failing tests**

Three cases, and the third is the one the spec's first draft missed:

- a generator returning a `program` fragment (a `def`) still expands at the
  top level
- a generator returning a `statements` fragment whose nodes are all legal
  (`const x = 1`) expands at the top level, and does **not** produce broken
  output
- a generator returning a fragment **containing an `if`** is refused with a
  message naming the `if` — for both a `statements` fragment and a `program`
  fragment
- **the mixed fragment**, which is the example the design was argued from:
  one fragment holding `const apiKey = getKey()` *and* `if (debug) { … }` is
  refused, naming the `if`. Testing all-legal and all-illegal separately
  leaves the case the rule exists for untested.
- a fragment containing a **`guard` block** is refused. Body-only forms
  cannot be parsed at the top level, so this path is the only way they reach
  the check at all — and the table rows it consults (`guardBlock: false` and
  its neighbours) are otherwise exercised nowhere.

The program-fragment case is constructible and currently crashes. A literal
holding an `if` and a `def` infers kind `program`, because the statements
attempt fails on the `def`:

```
[|
  if (true) {
    print(1)
  }

  def helper(): number {
    return 1
  }
|]
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/preprocessors/expandSplices.test.ts -t "top level"
```

Expected: the `if`-containing cases FAIL — today one emits unparseable
TypeScript and the other crashes.

- [ ] **Step 3: Replace the kind entry with the predicate**

In `expandSplices.ts`, declaration position stops asking about kind alone.
Accept a `program` fragment, or a `statements` fragment; then check every
node against the predicate regardless of which it was:

```ts
  if (splice.position === "decl") {
    const illegal = code.nodes.find((node) => !isLegalAtTopLevel(node));
    if (illegal !== undefined) {
      return {
        ok: false,
        diagnostic: {
          diagnostic: "spliceTopLevelStatement",
          params: { name: generatorName, kind: illegal.type },
          loc: splice.loc ?? ORIGIN_UNKNOWN,
        },
      };
    }
  }
```

`KINDS_FOR_POSITION.decl` is **unchanged**:

```ts
  decl: [...KINDS_FOR_SORT.decl, "statements"],
```

The kind gate keeps admitting both shapes; the per-node check above is what
decides. Removing `"statements"` would refuse every statements generator at
the top level regardless of content, which is the opposite of the goal.

Add the `spliceTopLevelStatement` diagnostic alongside the other splice
diagnostics, naming the generator and the offending statement.

Checking `program` fragments too is not needed for safety once Task 2's
builder pre-pass exists — it is for the message, so the error names the
generator instead of pointing at expanded code the user did not write.

- [ ] **Step 4: Run everything that touches splices**

```bash
pnpm test:run lib/preprocessors/ lib/compiler/
make
```

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must not be main
git add lib/preprocessors/
git commit -F - <<'EOF'
fix: a top-level splice is held to the top-level rule

Declaration position accepted any statements fragment, so a generated
`if` reached the backend and emitted TypeScript that does not parse. A
`program` fragment could carry the same crash past the check entirely.

Check every node of the fragment against isLegalAtTopLevel instead, so
generated code is held to the standard written code is held to.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: End to end, and the interrupt bug

**Files:**
- Create: `tests/agency/templates/spliceInBody.agency` + `.test.json`
- Create: `tests/agency/templates/spliceInBodyGen.agency`

- [ ] **Step 1: Write the fixture from the original report**

`spliceInBodyGen.agency`:

```ts
import { Code } from "std::agency"

export static const call = [|
  const spliced = "hello from a spliced statement"
  print(spliced)
|]

export def callFunc(): Code {
  return call
}
```

`spliceInBody.agency`:

```ts
import { callFunc } from "./spliceInBodyGen.agency"

// The original report: a generator returning statements, spliced into a
// node body. Refused before this change because a body splice was in
// expression position.
node main(): string {
  $( callFunc() )
  return "ok"
}
```

with the usual `.test.json` asserting `"ok"`.

- [ ] **Step 2: Build and run**

```bash
make
pnpm run a test tests/agency/templates/spliceInBody.agency 2>&1 | tee /tmp/splice-fixture.log
```

Expected: PASS. There are no splice execution fixtures under `tests/agency/`
today, so there is no neighbour to copy — if the generator's return type or
the import shape does not compile, take the working shapes from
`lib/preprocessors/expandSplices.test.ts` or `docs/dev/splices.md`, which is
where the working examples live.

- [ ] **Step 3: File the interrupt bug**

Both `interrupt("x")` and `static interrupt("x")` at file scope compile and
then crash at run time with `__self is not defined`. This branch turns that
into a compile-time refusal, which is a better error but not a fix. File it,
with the measurements, and note that `staticStatementParser` lists
`interruptStatementParser` among the legal inner forms — so the parser
records an intent the backend never implemented, and closing the gap means
deciding whether a top-level interrupt should work at all.

Write the body to a file and pass `--body-file`.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # must not be main
git add tests/agency/templates/
git commit -F - <<'EOF'
test: end-to-end fixture for a statements generator in a node body

The case from the original report: a generator returning statements,
spliced into a node body, filled and run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

# Before opening the PR

- [ ] **Audit the diff** against `docs/dev/anti-patterns.md` and
  `docs/dev/coding-standards.md`. Keep comments short — only what the next
  person would be misled without.
- [ ] `pnpm run lint:structure`
- [ ] `make` — exit 0.
- [ ] `pnpm test:run 2>&1 | tee /tmp/full.log` — read the log, do not re-run.
- [ ] `pnpm run a test tests/agency/templates`
- [ ] **State the breaking changes in the PR description.** `return`, `goto`,
  `interrupt(…)` and `static interrupt(…)` at file scope compile today and
  will not after this. All four are meaningless or broken there, so the
  exposure is small — but `static interrupt(…)` was a deliberate design, and
  refusing it is a decision reviewers should see rather than discover.
- [ ] PR description in a file, passed with `--body-file`.
- [ ] `git worktree remove worktree-top-level` once merged.

---

# Self-review notes

**Spec coverage.** The predicate and its exhaustive table: Task 1, including
the `static` wrapper and the placement-set tie. The compile-path diagnostic
and the builder guarantee: Task 2, which closes #713. Statement position:
Task 3, with the exhaustive message switch. The per-node decl check and the
program-fragment hole: Task 4. The interrupt verdict: Task 1's table, Task
2's tests, and Task 5's bug report.

**Placeholders.** None. Two steps deliberately defer to the surrounding code
rather than inventing an interface — Task 2 Step 1 on the `typeCheck`
signature, Task 3 Step 1 on how `expandSplices.test.ts` stands up a
generator — because guessing those would produce code that does not run.

**Type consistency.** `isLegalAtTopLevel(node)` is defined in Task 1 and
called with that signature in Tasks 2 and 4. `Splice["position"]` gains
`"statement"` in Task 3 and every consumer is updated in the same task.

**Known soft spots**, worst first:

1. **The table's `false` rows for sub-expression types.** Every literal form
   the top-level grammar can produce is now measured, so the known ones are
   settled — but if some expression form is reachable at file scope and
   compiles today and is not in the measured table, marking it `false` is a
   new refusal nobody asked for. Task 2 Step 8's wider suites are the
   backstop; a failure there naming an expression type means fixing the
   table, not the test.
2. **Where the type checker runs relative to splice expansion.** All five
   expansion paths run `expandSplices` before import resolution, and the
   checks run after — but I verified the ordering by reading, not by running
   each path. The builder pre-pass is what makes this non-fatal, and Task 2
   Step 6b is what proves the pre-pass is real.
3. **`describeKind`'s name map** is a hand-maintained list, exactly the thing
   this plan argues against elsewhere. Task 2 Step 4 says to look for an
   existing helper first. If none exists it is acceptable: an unmapped type
   falls back to its own name, so it fails ugly rather than wrong.

**Corrected after plan review.** The predicate table did not match the real
union: `Literal` is itself a union contributing seven type strings, so
`literal` was not a key at all, and `regexLiteral` should have been `regex`.
Measuring the missing forms also overturned one row I had guessed —
`debugger("x")` **crashes** at the top level, so `debuggerStatement` is
`false`, while bare `debugger` compiles because it parses as a
`variableName`. Also fixed: a test helper that skipped the very node one of
its own cases needed, a step that said to drop a table entry and then to keep
it, two diagnostics sharing one code, and a `staticStatement` guard that
would have failed open toward the crash the predicate exists to stop.
