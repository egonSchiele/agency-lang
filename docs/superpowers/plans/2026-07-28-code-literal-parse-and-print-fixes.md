# Code literal parse and print fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `node` and `def` declarations parsing as a variable followed by a function call, and stop the Agency printer writing to the program it was given.

**Architecture:** Three independent changes. (1) The printer keeps its reordered node list in a local instead of assigning it back over the caller's field. (2) A new alternative in the body grammar declines when a statement starts like a `node` or `def` declaration, which removes the bad reading everywhere and lets code-literal kind inference fall through to the program parser. (3) Kind inference treats a parser that *throws* during an attempt the same as one that fails, so a later attempt still runs.

**Tech Stack:** TypeScript, the tarsec parser combinator library (0.5.3), vitest for unit tests, the Agency test runner for execution fixtures.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-28-code-literal-parse-and-print-fixes-design.md`
**Review of that spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-28-code-literal-parse-and-print-fixes-design-REVIEW.md`

## Global Constraints

- **Never commit to `main`.** Task 0 creates the branch. Check `git branch --show-current` before every commit.
- **The new parser must return `committedFailure`, not `parseError` and not plain `failure`.** All three were checked against tarsec 0.5.3. `parseError` throws, and a throw is the cause of the bug Task 3 fixes. A plain `failure` is worse than useless here: `or` treats it as "this alternative declined, try the next one" (`combinators.js:178-190`), and the alternatives after ours include the very parsers that read `node` as a variable name — so the fix would be a silent no-op. `committedFailure(message, rest)` is a failure that stops backtracking: `or` returns it instead of trying later alternatives, and it does not throw. It is already imported (`lib/parsers/parsers.ts:62`) and is the established pattern for this job in this file (the nested-literal directive at `parsers.ts:3040-3042`).
- **"Expected FAIL, observed PASS" is a stop condition.** Every run-to-fail step exists to prove the test is not vacuous. If a test passes before its fix is written, stop and work out why — do not proceed. Two of the bugs here are exactly the kind that a badly-written test would fail to notice.
- **Do not change `RESERVED_WORDS`** (`lib/parsers/parsers.ts:213`) or make keywords illegal as identifiers. `const node = 1` must keep compiling.
- **Do not touch kind inference for `type` or `effect` bodies.** Both are explicitly out of scope; they are legal inside bodies and their current `statements` answer is correct.
- **Run `make`, not `pnpm run build`,** before any test that goes through `dist/` (all the `agency` CLI commands and every execution fixture).
- Unit tests: `pnpm test:run <path>`. Execution fixtures: `pnpm run a test <path>`. Do not run the full agency suite locally; CI does that.

---

# Background: what is broken and why

Read this before starting. The two bugs are unrelated to each other, and the
first one is not what it looks like.

## Bug A: a declaration parses as a name followed by a call

Agency lets a function call take a trailing block, so `main() { ... }` is a
valid call. Agency also does not reserve its keywords in expression position,
so `node` is a perfectly good variable name — `const node = 1` compiles today.

Put those together and this:

```ts
node main() {
  node inner() { print(1) }
  print("x")
}
```

parses as *two statements*: the bare name `node`, evaluated and thrown away,
then a call to a function called `inner` that takes a block. It compiles, and
it dies at run time with `ReferenceError: node is not defined`. `def helper()
{ return 1 }` in a body does the same thing.

A return type annotation saves you — `node main(): string { ... }` cannot be
read as a call, so it parses correctly. That is why nobody noticed.

## Why code literals make it worse

A code literal body (`[| ... |]`) is parsed by `parseCodeLiteralBody`
(`lib/parsers/parsers.ts:3044`), which tries three ways and takes the first
that consumes the whole body:

1. as a single expression (line 3059)
2. as a list of statements (line 3063)
3. as a whole program (line 3067)

When a user writes `[| node main() { ... } |]`, attempt 2 succeeds with the
wrong tree, so attempt 3 — which would have produced a correct `graphNode` —
never runs. The literal ends up holding a name and a call, `agency fmt` prints
it back as `node` on one line and `main() {` on the next, and `runCode`
generates a program that calls a function that does not exist.

**The fix is in the body grammar, not in the literal.** Once a statement that
starts like a declaration is declined, attempt 2 fails and attempt 3 runs. No
peeking at the body, no keyword routing.

## Bug A-adjacent: a throw abandons the remaining attempts

`[| static const x = 1 |]` does not mis-parse — it fails outright, with a
message about function bodies. `bodyReservedModifierParser`
(`lib/parsers/parsers.ts:4451`) exists to explain `static const` written
inside a function body, and it reports through tarsec's `parseError`, which
**throws**. The throw leaves `parseCodeLiteralBody` before attempt 3 runs, so
a body that is a perfectly good program is rejected by a diagnostic meant for
somewhere else.

Verified and load-bearing for Task 3: tarsec's `runNested` restores the
enclosing parse's state in a `finally` block, documented as covering "success,
failure, or throw". So catching the throw outside `runNested` is safe and does
not corrupt the enclosing parse.

## Bug B: the printer writes to the program it was given

`AgencyGenerator.generate` (`lib/backends/agencyGenerator.ts:223`) does:

```ts
program.nodes = this.partitionImports(program.nodes);
```

`partitionImports` pulls the header and imports out of the node stream so the
import block can be sorted, and the result is assigned back over the caller's
field. Harmless for a program parsed from a file. Not harmless for a `Code`
value held in a `static const`: statics are `__deepFreeze`d on purpose
(`lib/typeChecker/staticInitRules.ts:114-124`), and writing to a frozen object
throws in strict mode. So `toSource(someStaticLiteral)` fails with:

```
TypeError: Cannot assign to read only property 'nodes' of object
```

Every example in the guide calls `fill` first, and `fill` works on a deep
clone, which is why this was masked.

---

# File structure

| File | Change |
| --- | --- |
| `lib/backends/agencyGenerator.ts` | Task 1. Keep the partitioned node list in a local; passes 3, 4, 5 read it. |
| `lib/backends/agencyGenerator.test.ts` | Task 1. Two tests: no mutation, frozen input. |
| `lib/parsers/parsers.ts` | Task 2. New `bodyDeclarationParser`, added to `_bodyNodeParser`. Task 3. Throw containment in `parseCodeLiteralBody`. |
| `lib/parsers/body.test.ts` | Task 2. Body-level behavior and the keyword-as-variable guards. |
| `lib/parsers/codeLiteral.test.ts` | Tasks 2 and 3. Kind inference results and regression guards. |
| `lib/backends/agencyGenerator.roundtrip.test.ts` | Task 4. Byte-exact golden for an un-annotated node in a literal. |
| `tests/agency/templates/literalNodeDeclaration.agency` + `.test.json` | Task 4. End-to-end fixture. |
| `tests/agency/templates/staticToSource.agency` + `.test.json` | Task 4. End-to-end fixture for Bug B. |
| `docs/dev/template-agency.md` | Task 5. Correct the kind-inference paragraph and a stale path. |

---

### Task 0: Branch

- [ ] **Step 1: Confirm you are not about to work on main**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
git branch --show-current
```

Expected: `main`. That is why this step exists.

- [ ] **Step 2: Create the branch**

```bash
git checkout -b adit/code-literal-parse-and-print-fixes
git branch --show-current
```

Expected: `adit/code-literal-parse-and-print-fixes`

---

### Task 1: The printer stops writing to its input

This is Bug B, and it is independent of everything else. Doing it first gets a
small, verifiable change committed before the parser work starts.

**Files:**
- Modify: `lib/backends/agencyGenerator.ts:198-260`
- Test: `lib/backends/agencyGenerator.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on. `generateAgency(program)` keeps its
  existing signature `(program: AgencyProgram, opts?: { preserveOrder?: boolean }) => string`.

- [ ] **Step 1: Write the failing tests**

Add at the end of `lib/backends/agencyGenerator.test.ts`. Note the import of
`deepFreeze` from the runtime, which is where the real freezing comes from.

```ts
import { generateAgency } from "./agencyGenerator.js";
import { deepFreeze } from "../runtime/utils.js";

describe("AgencyGenerator - does not modify its input", () => {
  // The import sits BELOW the declaration on purpose. Hoisting is what
  // makes the printer want to rewrite the node list, so a source where the
  // import is already at the top cannot tell you whether hoisting still
  // happens after the fix.
  const source = [
    "// a header comment",
    "node main(): string {",
    '  return "x"',
    "}",
    "",
    'import { read } from "std::fs"',
    "",
  ].join("\n");

  function parseOk(text: string) {
    const result = parseAgency(text, {}, false);
    if (!result.success) throw new Error(result.message);
    return result.result;
  }

  it("leaves the caller's program untouched", () => {
    const program = parseOk(source);
    // Whole-tree comparison, not a list of node types: a type list is
    // blind to a mutation inside a node, or to a reorder among nodes of
    // the same type. This asserts the invariant the fix is really about.
    const before = JSON.stringify(program);
    generateAgency(program);
    expect(JSON.stringify(program)).toBe(before);
  });

  it("prints a deep-frozen program without throwing", () => {
    // A `static const` Code value is deep-frozen at init, so this is the
    // exact shape `toSource(someStaticLiteral)` hands the printer.
    const program = deepFreeze(parseOk(source));
    expect(() => generateAgency(program)).not.toThrow();
  });

  it("still hoists imports above declarations", () => {
    // Order, not presence. A `toContain` pair would stay green if
    // partitioning were deleted outright, which is the thing this guards.
    const printed = generateAgency(parseOk(source));
    expect(printed.indexOf('import { read } from "std::fs"')).toBeLessThan(
      printed.indexOf("node main(): string {"),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts -t "does not modify its input"
```

Expected: the first two FAIL. The frozen one fails with `Cannot assign to read
only property 'nodes'`; the mutation one fails because the serialized tree
differs after the call. The third should already pass — it is the guard that
the fix does not disable hoisting, and it must stay green through the change.

- [ ] **Step 3: Make the change**

In `lib/backends/agencyGenerator.ts`, replace lines 222-224:

```ts
    if (!this.preserveOrder) {
      program.nodes = this.partitionImports(program.nodes);
    }
```

with:

```ts
    // A local, never a write-back. The caller may own this tree — a `Code`
    // value from a `static const` is deep-frozen, and assigning to
    // `program.nodes` throws. Passes 3, 4 and 5 below read `nodes`; passes
    // 1 and 2 above ran before the partition and read `program.nodes`.
    const nodes = this.preserveOrder
      ? program.nodes
      : this.partitionImports(program.nodes);
```

Then change the three loops that run *after* that point to iterate `nodes`
instead of `program.nodes`:

- line 227 — `// Pass 3: Collect all node imports`
- line 234 — `// Pass 4: Generate code for tools`
- line 254 — `// Pass 5: Process all nodes and generate code`

Leave passes 1 (line 203) and 2 (line 210) reading `program.nodes`. They run
before the partition today and must keep doing so.

Do not change anything else in the method.

If the frozen test *still* throws after this change, the write-back was not
the printer's only mutation of its input — some pass rewrites something
deeper. Find it and fix it the same way: derive a local, never write back. Do
not respond by cloning the input inside `generateAgency`; that hides the
mutation instead of removing it, and leaves the next caller who passes a
shared tree to trip over it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Run the formatter gate, which is the real check**

```bash
pnpm test:run lib/backends/agencyGenerator.roundtrip.test.ts
```

Expected: PASS. This runs the whole fixture corpus through print and re-parse
with byte-exact goldens. If pass ordering was got wrong, this is what catches
it.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must not be main
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts
git commit -F - <<'EOF'
fix: the Agency printer no longer writes to the program it is given

generate() assigned the partitioned node list back over the caller's
`nodes` field. A `Code` value from a `static const` is deep-frozen, so
`toSource` on an unfilled template threw a TypeError. Keep the
partitioned list in a local instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: `node` and `def` in statement position stop parsing as a name

This is the core of Bug A. It fixes ordinary bodies and code literals with one
change, because the literal's statements attempt now fails and its program
attempt runs.

**Files:**
- Modify: `lib/parsers/parsers.ts` — add `bodyDeclarationParser` near
  `bodyReservedModifierParser` (around line 4451), and register it in
  `_bodyNodeParser` (line 4576)
- Test: `lib/parsers/body.test.ts`, `lib/parsers/codeLiteral.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `BODY_DECLARATION_MESSAGE` (a module-level `const string` in
  `parsers.ts`, not exported) and `bodyDeclarationParser: Parser<never>`. Task
  3 does not use either; it only relies on the behavior.

- [ ] **Step 1: Write the failing body-level tests**

Append to `lib/parsers/body.test.ts`:

```ts
describe("declarations are not legal in a body", () => {
  // These assert a FAILURE, not a partial success. The decline is a
  // committed failure, and `many` fails the whole repetition when it meets
  // one (tarsec combinators.js:40-42) — which is exactly what a code
  // literal needs, since kind inference only reaches the program parser if
  // the statements attempt fails outright.
  const declarations = [
    "node inner() { print(1) }",
    "def helper() { return 1 }",
    "print(1)\nnode inner() { print(2) }",
    "if (true) { node inner() { print(1) } }",
  ];

  for (const source of declarations) {
    it(`fails on: ${source.split("\n")[0]}`, () => {
      const result = bodyParser(source);
      expect(result.success, source).toBe(false);
      expect(result.message, source).toContain(
        "only legal at the top level of a file",
      );
    });
  }
});

describe("keyword-as-variable statements still parse", () => {
  // `node` is a legal variable name (`const node = 1` compiles today).
  // Every one of these has a non-identifier character after the keyword,
  // which is what keeps them out of the declaration shape check.
  const cases: { input: string; firstType: string }[] = [
    { input: "node.run()", firstType: "valueAccess" },
    { input: "node + 1", firstType: "binOpExpression" },
    { input: "node(1)", firstType: "functionCall" },
    { input: "node", firstType: "variableName" },
    { input: "debugger", firstType: "variableName" },
    { input: "nodeCount()", firstType: "functionCall" },
    // Keyword followed by a word is the reason the probe requires a name
    // AND a `(`. All three parse today (verified), and a probe that
    // stopped at "keyword, space, identifier" would decline them — which,
    // being a committed failure, turns something that parses into a hard
    // error. `node is string` is three bare-name statements, not an
    // `is` expression; it is junk, but it is junk that parses, and this
    // change is not the place to start rejecting it.
    { input: "node is string", firstType: "variableName" },
    { input: "node as Foo", firstType: "variableName" },
    { input: "node in items", firstType: "binOpExpression" },
  ];

  for (const { input, firstType } of cases) {
    it(`parses \`${input}\` as before`, () => {
      const result = bodyParser(input);
      expect(result.result.length, input).toBeGreaterThan(0);
      expect(result.result[0].type, input).toBe(firstType);
      expect(result.rest.trim(), input).toBe("");
    });
  }
});
```

If any `firstType` above turns out to be spelled differently in this codebase,
fix the expectation to match what the parser actually produces — run
`pnpm run ast` on a small file to check. Do not fix it by loosening the
assertion; the point is that these keep their exact reading.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm test:run lib/parsers/body.test.ts -t "declarations are not legal in a body"
```

Expected: the three declining tests FAIL, because today `bodyParser` consumes
the whole input and produces `variableName` + `functionCall`. The
keyword-as-variable tests should already PASS — they are the regression guards
and must stay green through the next step.

- [ ] **Step 3: Add the parser**

In `lib/parsers/parsers.ts`, directly after `bodyReservedModifierParser` (it
ends around line 4462), add:

```ts
const BODY_DECLARATION_MESSAGE =
  "`node` and `def` declarations are only legal at the top level of a file.";

/**
 * Decline a statement that starts like a `node` or `def` declaration.
 *
 * A call may take a trailing block and keywords are not reserved in
 * expression position, so `node main() { ... }` in a body otherwise parses
 * as the name `node` followed by a call to `main`. That tree compiles and
 * fails at run time with `node is not defined`. Declining removes the
 * reading; inside a code literal it is also what lets kind inference fall
 * through to the program parser, where a declaration belongs.
 *
 * The probe mirrors the real declaration prefix — keyword, whitespace,
 * name, `(` — the same shape `graphNodeParser` and `_baseFunctionParser`
 * consume, and it reuses `varNameChar`, the codebase's single definition of
 * an identifier character. Requiring the `(` is what keeps ordinary uses of
 * `node` as a variable out of the decline: `node.run()` and `node + 1` fail
 * at the whitespace, `node (x)` and `node is string` fail for want of a
 * name-then-paren, `nodeCount()` fails because `str("node")` is not
 * followed by whitespace.
 *
 * `committedFailure`, never plain `failure` and never `parseError`. A plain
 * failure means "try the next alternative", and the alternatives below
 * include the parsers that read `node` as a name — the decline would do
 * nothing at all. `parseError` throws, which escapes
 * `parseCodeLiteralBody`'s statements attempt and abandons the program
 * attempt, the bug `bodyReservedModifierParser` causes for `static const`.
 * A committed failure stops backtracking without throwing, which is exactly
 * the job; same pattern as the nested-literal directive above.
 */
const bodyDeclarationParser: Parser<never> = (input: string) => {
  const probe = seqC(
    or(str("node"), str("def")),
    many1(space),
    many1WithJoin(varNameChar),
    optionalSpaces,
    char("("),
  );
  const probed = probe(input);
  if (!probed.success) {
    return failure("", input);
  }
  // Fail past the declaration name, not at `input`: rightmost-failure
  // reporting prefers the failure that got furthest, and this message is
  // the one the user needs.
  return committedFailure(BODY_DECLARATION_MESSAGE, probed.rest) as ParserResult<never>;
};
```

Then register it in `_bodyNodeParser` (line 4576), immediately after
`bodyReservedModifierParser`:

```ts
const _bodyNodeParser: Parser<AgencyNode> = memo("bodyNodeParser", or(
  keywordParser,
  effectSetDeclParser,
  effectDeclParser,
  typeAliasParser,
  tagParser,
  bodyReservedModifierParser,
  // Next to bodyReservedModifierParser because it does the same job: both
  // decline a top-level-only declaration written inside a body. This one
  // must sit ahead of assignmentParser / binOpParser / valueAccessParser,
  // which are what would otherwise read `node` as a name.
  bodyDeclarationParser,
  // ... rest of the list unchanged
```

- [ ] **Step 4: Run the body tests**

```bash
pnpm test:run lib/parsers/body.test.ts
```

Expected: PASS, all of them — the three new declining tests and every
keyword-as-variable guard.

- [ ] **Step 5: Add the code-literal tests**

Append to `lib/parsers/codeLiteral.test.ts`, using the file's existing
`firstLiteral` helper:

```ts
describe("declarations in a literal infer program", () => {
  const cases: { body: string; nodeType: string; label: string }[] = [
    { label: "un-annotated node", body: "node main() {\n  print(1)\n}", nodeType: "graphNode" },
    { label: "un-annotated def", body: "def foo() {\n  return 1\n}", nodeType: "function" },
    { label: "node with parameters", body: "node m(x: number) {\n  print(x)\n}", nodeType: "graphNode" },
    { label: "two declarations", body: "node a() {\n  print(1)\n}\n\nnode b() {\n  print(2)\n}", nodeType: "graphNode" },
    { label: "comment first", body: "// hi\nnode main() {\n  print(1)\n}", nodeType: "graphNode" },
    { label: "statement then declaration", body: "print(1)\nnode main() {\n  print(2)\n}", nodeType: "functionCall" },
  ];

  for (const { label, body, nodeType } of cases) {
    it(`infers program for a ${label}`, () => {
      const lit = firstLiteral(`node host() {\n  const t = [|\n${body}\n  |]\n}\n`);
      expect(lit.kind, label).toBe("program");
      // The kind alone is not enough: it was already wrong for a reason
      // only the node type reveals.
      expect(lit.nodes[0].type, label).toBe(nodeType);
      expect(lit.nodes.map((node) => node.type), label).not.toContain("variableName");
    });
  }

  it("still infers program for an annotated node", () => {
    const lit = firstLiteral(`node host() {\n  const t = [|\n    node main(): string {\n      return "x"\n    }\n  |]\n}\n`);
    expect(lit.kind).toBe("program");
    expect(lit.nodes[0].type).toBe("graphNode");
  });

  it("still infers program for an annotated def", () => {
    // `def` takes the other branch of the probe's `or`, so it needs its
    // own annotated case, not just the un-annotated one above.
    const lit = firstLiteral(`node host() {\n  const t = [|\n    def foo(): number {\n      return 1\n    }\n  |]\n}\n`);
    expect(lit.kind).toBe("program");
    expect(lit.nodes[0].type).toBe("function");
  });

  it("reports a broken declaration instead of silently reading two statements", () => {
    // Before the fix this parsed as statements and produced junk. Now the
    // statements attempt declines and the program attempt's error is what
    // the user sees.
    const source = `node host() {\n  const t = [|\n    node main( {\n      print(1)\n    }\n  |]\n}\n`;
    const result = parseAgency(source, {}, true, false);
    expect(result.success).toBe(false);
  });
});

describe("the body-declaration message reaches an ordinary parse", () => {
  // Task 2 Step 7 checks how this looks in the CLI. This pins that the
  // message is there at all, so a later parser change cannot quietly
  // degrade it to a generic failure.
  it("names the top-level rule for a node declaration in a body", () => {
    const result = parseAgency(`node main() {\n  node inner() {\n    print(1)\n  }\n}\n`, {}, false);
    expect(result.success).toBe(false);
    expect(result.message).toContain("only legal at the top level of a file");
  });
});

describe("bodies whose kind must not change", () => {
  // Finding 1 and Finding 2 regression guards. Each of these begins with a
  // word that a keyword-routing fix would have misread.
  const cases: { body: string; kind: string }[] = [
    { body: "node", kind: "expr" },
    { body: "node.run()", kind: "expr" },
    { body: "node + 1", kind: "expr" },
    { body: "const x = 1", kind: "statements" },
    { body: "print(1)", kind: "expr" },
    { body: "type P = { n: number }", kind: "statements" },
    { body: "effect Foo", kind: "statements" },
  ];

  for (const { body, kind } of cases) {
    it(`keeps \`${body}\` as ${kind}`, () => {
      const lit = firstLiteral(`node host() {\n  const node = 1\n  const t = [| ${body} |]\n  print("x")\n}\n`);
      expect(lit.kind, body).toBe(kind);
    });
  }
});
```

- [ ] **Step 6: Run them**

```bash
pnpm test:run lib/parsers/codeLiteral.test.ts
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 7: Check the error message a real body now produces**

This is the one part of the task that is not mechanical, and it is worth
looking at with your own eyes rather than trusting a test.

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
make
mkdir -p investigate
printf 'node main() {\n  node inner() { print(1) }\n  print("x")\n}\n' > investigate/decl.agency
pnpm run agency compile investigate/decl.agency
```

Expected: a parse error naming the file, line and column, whose text is
`BODY_DECLARATION_MESSAGE`.

If the message comes out generic instead, tarsec's rightmost-failure
reporting picked a different alternative's failure. The fix is to make this
parser's failure the rightmost one — it already fails at `probed.rest`
(past `node ` and the first name character); if that is not far enough,
extend the probe to also consume the declaration name up to `(` before
failing. Do **not** switch to `parseError` to force the message through: the
throw is what breaks Task 3.

- [ ] **Step 8: Run the broader parser and generator suites**

```bash
pnpm test:run lib/parsers/ lib/backends/
```

Expected: PASS.

How to read a failure here. A committed failure travels further than an
ordinary one: it propagates out through `or` and `many` by design, and
`bodyParser` is used for every block in the language, including places the
grammar speculatively tries a block-shaped parse and expects to back out and
take a different reading. So a pre-existing test failing with
`BODY_DECLARATION_MESSAGE` means the decline escaped a context that used to
backtrack.

**The repair for that is narrowing the probe, never weakening the
commitment.** Weakening it to a plain `failure` makes the whole change a
no-op — see the Global Constraints. Narrow by tightening what the probe
requires before it commits, and add the escaping case to the
keyword-as-variable guard table so it stays pinned.

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # must not be main
git add lib/parsers/parsers.ts lib/parsers/body.test.ts lib/parsers/codeLiteral.test.ts
git commit -F - <<'EOF'
fix: a node or def declaration in a body is no longer read as a name

A call may take a trailing block and keywords are not reserved in
expression position, so `node main() { ... }` inside a body parsed as
the name `node` followed by a call to `main`. It compiled and died at
run time with `node is not defined`. In a code literal it also beat the
program parser, so a declaration in a template became a call.

Decline the declaration shape in body position instead. Code literals
now fall through to the program parser and get the right tree.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: A throw during one kind attempt must not abandon the others

**Files:**
- Modify: `lib/parsers/parsers.ts:3044-3093` (`parseCodeLiteralBody`)
- Test: `lib/parsers/codeLiteral.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 by name — only the behavior that a
  declaration-shaped statement now makes the statements attempt fail.
- Produces: a module-local `tryAttempt` helper. Not exported.
  `parseCodeLiteralBody`'s exported signature is unchanged:
  `(body: string, base?: Position) => ParsedLiteralBody`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/parsers/codeLiteral.test.ts`:

```ts
describe("a throwing attempt does not abandon the remaining attempts", () => {
  // `static const` is rejected inside a function body by a parser that
  // reports through tarsec's parseError, which THROWS. A literal body may
  // legitimately be a whole program, where `static const` is correct.
  it("parses a static const literal as a program", () => {
    const lit = firstLiteral(`node host() {\n  const t = [|\n    static const x = 1\n  |]\n  print("x")\n}\n`);
    expect(lit.kind).toBe("program");
    expect(lit.nodes[0].type).toBe("assignment");
  });

  it("parses a static const written after another statement", () => {
    const lit = firstLiteral(`node host() {\n  const t = [|\n    const a = 1\n    static const x = 2\n  |]\n  print("x")\n}\n`);
    expect(lit.kind).toBe("program");
    expect(lit.nodes.map((node) => node.type)).toEqual(["assignment", "assignment"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm test:run lib/parsers/codeLiteral.test.ts -t "throwing attempt"
```

Expected: FAIL. Both throw out of the parse with the message beginning
`` `static` and `export` declarations are only supported at module top level ``.

- [ ] **Step 3: Add the containment**

In `lib/parsers/parsers.ts`, directly above `parseCodeLiteralBody` (line
3044), add:

```ts
/**
 * Run one kind attempt, treating a throw as a non-match.
 *
 * A parser reached during an attempt may throw rather than fail: tarsec's
 * `parseError` does, and `bodyReservedModifierParser` uses it to explain
 * `static const` written inside a function body. That message is right for a
 * body and wrong for a literal, whose body may legitimately be a whole
 * program. An attempt that dies is an attempt that did not match, so the
 * remaining attempts must still run.
 *
 * Safe because `runNested` restores the enclosing parse's state in a
 * `finally` — success, failure, or throw — so a caught throw leaves no
 * corrupted state behind, and the committed-failure slot it swaps back is
 * the enclosing parse's own. Only `TarsecError` is converted; anything else
 * is a real bug and still propagates.
 *
 * Returns a `ParserResult` rather than null, so a caught throw IS a
 * failure: the call sites keep their ordinary `.success` checks, and the
 * thrown message survives instead of being discarded.
 */
function tryAttempt<T>(run: () => ParserResult<T>): ParserResult<T> {
  try {
    return run();
  } catch (error) {
    if (error instanceof TarsecError) {
      return failure(error.message, "") as ParserResult<T>;
    }
    throw error;
  }
}
```

Then, inside `parseCodeLiteralBody`, wrap the first two attempts. Replace:

```ts
    const asExpr = runNested(exprParser, trimmed, { basePosition: trimmedBase });
    if (asExpr.success && stripSentinels(asExpr.rest).trim() === "") {
      return { ok: true, nodes: [asExpr.result as AgencyNode], kind: "expr" };
    }
    const asStatements = runNested(bodyParser, trimmed, { basePosition: trimmedBase });
    if (asStatements.success && stripSentinels(asStatements.rest).trim() === "") {
      return { ok: true, nodes: asStatements.result as AgencyNode[], kind: "statements" };
    }
```

with:

```ts
    const asExpr = tryAttempt(() =>
      runNested(exprParser, trimmed, { basePosition: trimmedBase }),
    );
    if (asExpr.success && stripSentinels(asExpr.rest).trim() === "") {
      return { ok: true, nodes: [asExpr.result as AgencyNode], kind: "expr" };
    }
    const asStatements = tryAttempt(() =>
      runNested(bodyParser, trimmed, { basePosition: trimmedBase }),
    );
    if (asStatements.success && stripSentinels(asStatements.rest).trim() === "") {
      return { ok: true, nodes: asStatements.result as AgencyNode[], kind: "statements" };
    }
```

Only the two `runNested` calls are wrapped. The `if` conditions are unchanged
— that is the point of returning a `ParserResult` rather than a nullable.

Leave the program attempt alone. It is the last one, so a throw from it is
the answer, not something to recover from.

`TarsecError` is already imported at `lib/parsers/parsers.ts:8`. Do not add an
import.

- [ ] **Step 4: Run the tests**

```bash
pnpm test:run lib/parsers/codeLiteral.test.ts
```

Expected: PASS, all of them.

- [ ] **Step 5: Confirm a genuinely broken literal still reports well**

The containment must not swallow real errors into a confusing program-parse
message.

```bash
pnpm test:run lib/parsers/codeLiteral.test.ts -t "unclosed"
pnpm test:run lib/parsers/codeLiteral.test.ts -t "nested"
```

Expected: PASS. These pin the committed-failure directives ("unclosed code
literal", "literals do not nest"), which must still win error reporting.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must not be main
git add lib/parsers/parsers.ts lib/parsers/codeLiteral.test.ts
git commit -F - <<'EOF'
fix: a throwing parser no longer abandons the remaining literal attempts

`[| static const x = 1 |]` failed with a message about function bodies.
The body-context diagnostic for `static const` reports through tarsec's
parseError, which throws, and the throw escaped before the program
attempt ran. Treat a thrown TarsecError as a non-match so kind
inference continues.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: End-to-end coverage

Unit tests pin the trees. These pin what a user actually experiences: the
formatter output, and a template that is filled, printed, re-parsed, compiled
and run.

**Files:**
- Modify: `lib/backends/agencyGenerator.roundtrip.test.ts`
- Create: `tests/agency/templates/literalNodeDeclaration.agency`
- Create: `tests/agency/templates/literalNodeDeclaration.test.json`
- Create: `tests/agency/templates/staticToSource.agency`
- Create: `tests/agency/templates/staticToSource.test.json`

**Interfaces:**
- Consumes: the behavior from Tasks 1, 2 and 3. No new code.
- Produces: nothing.

- [ ] **Step 1: Add the formatter golden**

Append to the final `describe` in
`lib/backends/agencyGenerator.roundtrip.test.ts`, next to the existing
`golden:` tests (around line 195), using that file's `parseTemplateMode`
helper:

```ts
  it("golden: an un-annotated node in a literal keeps its declaration", () => {
    // The reported symptom of the mis-parse was formatting: `node` and
    // `main() {` printed on separate lines, because the tree held a name
    // and a call. A byte-exact golden is what stops that coming back.
    const source = `node host() {\n  const t = [|\n    node main() {\n      print(1)\n    }\n  |]\n}\n`;
    const expected = [
      "node host() {",
      "  const t = [|",
      "    node main() {",
      "      print(1)",
      "    }",
      "  |]",
      "}",
      "",
    ].join("\n");
    expect(generateAgency(parseTemplateMode(source))).toBe(expected);
  });
```

- [ ] **Step 2: Run the gate**

```bash
pnpm test:run lib/backends/agencyGenerator.roundtrip.test.ts
```

Expected: PASS, including the whole-corpus round trip and idempotence checks.

- [ ] **Step 3: Write the execution fixture for the declaration case**

Create `tests/agency/templates/literalNodeDeclaration.agency`:

```ts
import { fill, toSource, runCode } from "std::agency"

// A node declaration written without a return type used to parse as the
// name `node` followed by a call. Nothing downstream caught it: the tree
// printed and re-parsed stably, and only the generated program failed. This
// runs the whole path — parse, fill, print, re-parse, compile, run — so the
// stages have to agree.
node main(): string {
  const tpl = [|
    node main() {
      const who: string = #who
      return "hello " + who
    }
  |]
  const filled = fill(tpl, { who: "world" })
  if (isFailure(filled)) {
    return "fill failed: ${filled.error}"
  }
  const source = toSource(filled.value)
  if (!source.includes("node main() {")) {
    return "bad source: ${source}"
  }
  handle {
    const result = runCode(source)
    if (isFailure(result)) {
      return "run failed: ${result.error}"
    }
    return result.value
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `tests/agency/templates/literalNodeDeclaration.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"hello world\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "A node declaration without a return type survives a literal, a fill, and a run"
    }
  ]
}
```

The generated program's `main` needs to be exported for `runCode` to find it —
if the run fails with a missing-node error, add `export` to the `node main()`
inside the literal and keep everything else the same.

- [ ] **Step 4: Write the execution fixture for the printer case**

Create `tests/agency/templates/staticToSource.agency`:

```ts
import { toSource } from "std::agency"

// A `static const` Code value is deep-frozen at init. The printer used to
// write its reordered node list back over the caller's `nodes` field, so
// this threw. Every other fixture calls `fill` first, which clones, and so
// never touched the frozen value.
static const template = [|
  node main() {
    print("hi")
  }
|]

node main(): string {
  const source = toSource(template)
  if (source.includes("node main() {")) {
    return "ok"
  }
  return "unexpected: ${source}"
}
```

Create `tests/agency/templates/staticToSource.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"ok\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "toSource prints a static const literal without an intervening fill"
    }
  ]
}
```

- [ ] **Step 5: Build and run both fixtures**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
make
pnpm run a test tests/agency/templates/literalNodeDeclaration.agency 2>&1 | tee /tmp/fixture1.log
pnpm run a test tests/agency/templates/staticToSource.agency 2>&1 | tee /tmp/fixture2.log
```

Expected: both PASS. Save the output — these are slow, and re-running them to
see what failed wastes more time than reading a log.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must not be main
git add lib/backends/agencyGenerator.roundtrip.test.ts tests/agency/templates/
git commit -F - <<'EOF'
test: end-to-end coverage for literal declarations and static toSource

A byte-exact formatter golden for an un-annotated node in a literal, and
two execution fixtures: one that fills, prints, compiles and runs a
generated node declaration, and one that calls toSource on a static
const literal with no fill in between.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Documentation

Two corrections, both small, both in the internals doc.

**Files:**
- Modify: `docs/dev/template-agency.md`

**Interfaces:** none.

- [ ] **Step 1: Correct the kind-inference claim**

`docs/dev/template-agency.md` currently says, in the code-literals section,
that kind is "inferred smallest-first" and that the expr-fills-statements
relaxation is "what makes this inference lossless". That is no longer the
whole story: smallest-first is only safe because a declaration-shaped
statement is now declined. Replace that sentence with:

```markdown
Kind is inferred smallest-first by `parseCodeLiteralBody`: a lone expression,
else a statement list, else a program; each attempt must consume the whole
body. The expr-fills-statements admissibility relaxation (see
`assertKindMatchesSort`) is what makes the expression case lossless — anything
inferred `expr` also works wherever statements go.

Smallest-first is only correct because the statement grammar refuses to read a
declaration. `node main() { … }` without a return type is otherwise a legal
statement list — the name `node`, then a call to `main` taking a trailing
block — so the statements attempt would win and the program attempt would
never run. `bodyDeclarationParser` declines that shape in body position, which
is what makes the fall-through to the program attempt happen. It declines with
an ordinary failure, never `parseError`: a throw escapes the attempt and
abandons the ones after it, which is why `parseCodeLiteralBody` also contains
throws from the expr and statements attempts (`tryAttempt`). Both are load
bearing; removing either silently restores the mis-parse.
```

- [ ] **Step 2: Fix the stale path**

Line 3 of the same file points the reader at
`docs/site/guide/templates.md`. That file does not exist — it is
`docs/site/guide/template-agency.md`. Correct it.

- [ ] **Step 3: Check nothing else claims the old behavior**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
grep -rn "smallest-first\|lossless" docs/dev/template-agency.md docs/site/guide/template-agency.md
```

Expected: only the passage you just rewrote. If the user-facing guide makes a
claim about kind inference, it does not need the internals detail — leave it
alone unless it is now wrong.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # must not be main
git add docs/dev/template-agency.md
git commit -F - <<'EOF'
docs: record why smallest-first kind inference is safe

Smallest-first only works because the statement grammar declines a
declaration shape, and because a throw during one attempt no longer
abandons the rest. Both are load bearing. Also fix a stale path to the
user guide.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

# Before opening the PR

- [ ] **Audit the diff against the anti-patterns doc.** Read
  `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md` and check the
  diff against both. This is a standing requirement in this repo, not
  optional.

- [ ] **Run the structural linter.**

```bash
pnpm run lint:structure
```

- [ ] **Run the full unit suite once and save the output.**

```bash
pnpm test:run 2>&1 | tee /tmp/full-test-run.log
```

Read the log rather than re-running to find out what failed. Do not run the
full agency execution suite locally — CI does that.

- [ ] **Delete the scratch directory** if `packages/agency-lang/investigate/`
  still exists from the investigation or from Task 2 Step 7. It is untracked
  and should not reach the PR.

- [ ] **PR description in a file, not on the command line.** Apostrophes on
  the command line fail in this repo. Write it to a file and pass
  `--body-file`.

---

# Self-review notes

Checked against the spec section by section.

**Spec coverage.** Part 1 Change 1 is Task 2; Part 1 Change 2 is Task 3; Part
2 is Task 1. Every row of the spec's "what this fixes" table has a test: the
six declaration shapes and the two `static const` shapes are in Tasks 2 and 3,
and the two body-level cases are in Task 2. Every row of "what deliberately
does not change" is a regression guard in Task 2 Step 5 and Step 1, including
`debugger`, which is the reason the check is narrow. The accepted regression
(`node` on one line, `main()` on the next) is not tested — it is a behavior we
accept rather than one we assert, and writing a test for it would pin a
consequence rather than a decision.

**Placeholders.** None. Every code step carries the code, every run step
carries the command and the expected result.

**Type consistency.** `bodyDeclarationParser` and `BODY_DECLARATION_MESSAGE`
are defined in Task 2 and referenced by those exact names in Task 5's doc
text. `tryAttempt` is defined and used only in Task 3.
`generateAgency(program, opts?)` keeps its existing signature in Task 1.

**Known soft spots**, in the order I would worry about them:

1. **Where a committed failure travels.** `bodyParser` parses every block in
   the language, and a committed failure propagates out through `or` and
   `many` by design. Somewhere the grammar may speculatively try a
   block-shaped parse and rely on ordinary failure to back out. I could not
   find a concrete case by reading; Task 2 Step 8 is the backstop, and that
   step now says how to read a failure there and which way to repair it.
2. **Task 2 Step 7's error message.** Whether rightmost-failure reporting
   surfaces `BODY_DECLARATION_MESSAGE` in an ordinary body cannot be settled
   by reading. Failing past the declaration name helps; the step says what to
   do if it is still not enough, and forbids the tempting wrong fix.
3. **Nothing pins that a non-`TarsecError` throw still propagates** out of
   `tryAttempt`. The `instanceof` filter is the only thing separating "an
   attempt that did not match" from "a swallowed compiler bug", and the
   helper is module-local, so there is no public surface to reach it from. I
   accept the gap rather than exporting the helper to test it, but it is a
   gap.

**Corrected after plan review.** Three things in the first draft were wrong,
all now fixed above: the parser returned a plain `failure`, which `or` treats
as "try the next alternative" — the fix would have been a silent no-op; the
body-level tests expected a partial success that committed semantics cannot
produce, and contradicted the literal table in the same task; and the probe
stopped at keyword-plus-identifier, which would have turned `node is string`
and friends into hard parse errors. The commit trailer stays as this session's
convention specifies.
