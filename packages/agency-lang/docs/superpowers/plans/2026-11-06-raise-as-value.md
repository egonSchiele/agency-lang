# `raise` as a Value Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `raise ...` be written wherever `interrupt ...` can already be written as a value, so that `const msg = raise interrupt("How do you feel?")` puts the user's answer in `msg`.

**Architecture:** `raise` and `interrupt` already produce the same tree node, `interruptStatement`. The `interrupt` spelling is one entry in the parser's list of things that can start an expression. This plan adds the `raise` spelling to the same list. Nothing after the parser needs to learn anything new, because the node is the same. Two side effects of that one entry are handled in the same change: a call to a function named `raise` becomes an interrupt, and the keyword must not read across a line break.

**Tech Stack:** TypeScript, the tarsec parser combinator library, vitest, Agency execution tests.

**Spec:** There is no spec document. The owner made the decision in conversation on 2026-11-06 ("we should allow `raise` as a value"). The Background section below records everything the decision rests on.

## Background

### What is wrong today

Agency has two spellings for raising an interrupt:

```ts
interrupt std::write("Save the file?", { filename: name })
raise std::write("Save the file?", { filename: name })
```

Both produce an `interruptStatement` node. The `raise` spelling adds the field `viaRaise: true`, which the formatter reads so that it prints the keyword the author wrote. The code generator and the type checker ignore that field.

The `interrupt` spelling can be used as a value. This works:

```ts
const msg = interrupt("How do you feel?")
```

The `raise` spelling cannot. It is only in the parser's list of statements. So the same line with `raise` does not mean what it says:

```ts
const msg = raise interrupt("How do you feel?")
```

Before PR #1406 the parser read that line as two statements: `const msg = raise`, which assigns from a variable named `raise`, and then `interrupt("How do you feel?")`, whose answer was thrown away. Since #1406 the line is a parse error, because a statement must be the last thing on its line.

Two documents use the broken form as if it worked:

- `docs/site/guide/interrupts-part-2.md`, lines 35 and 49.
- `packages/agency-lang/CLAUDE.md`, in the interrupts section: `let userResponse = raise std::getEnvName("What environment variable should I read?")`.

Both become correct once this plan lands. Neither needs an edit. Task 1 has a test that parses the guide's example.

### Where the code is

All line numbers are from `main` at commit `c0f0f91ac`.

- `lib/parsers/parsers.ts:4226`: `baseAtom`, the list of parsers that can start an expression. Line 4242 is `lazy(() => interruptExprParser)`. This is the entry that makes `interrupt` a value.
- `lib/parsers/parsers.ts:4734`: `_interruptExprParser`, the parser with no trailing whitespace handling. Line 4756 exports it wrapped in `withLoc` as `interruptExprParser`.
- `lib/parsers/parsers.ts:4782`: `_raiseExprParser`. It accepts five forms, listed in the comment above it. It is used only by `raiseStatementParser` on line 4817.
- `lib/backends/agencyGenerator.ts:1699`: `armPrintsInline`, which decides whether the formatter prints a match arm on one line. Lines 1707 to 1711 say that a `raise` arm must be printed as a block, because `=> raise ...` did not parse.
- `lib/backends/agencyGenerator.matchBlock.test.ts:104`: the round-trip rows for match arms, including "raise-statement arm keeps its block" and "interrupt-expression arm stays inline".

### What a spike showed

I made the parser change as a throwaway and then reverted it. With `raise` added to `baseAtom`:

- All five forms parse as a value in an assignment, a `return`, a call argument, a match arm, and before `with approve`.
- `raiseHand(1)` still parses as a call to a function named `raiseHand`, and `const raised = ...` still declares a variable.
- The unit tests under `lib/parsers`, `lib/backends`, `lib/typeChecker`, `lib/preprocessors`, and `lib/utils` all pass: 5,893 tests in 289 files.
- The formatter prints `1 => raise feel("x")` as a block arm, because of the branch in `armPrintsInline`. That is the one place after the parser that needs a change.

That spike ran only the unit tests, and it missed two things that a review of this plan found. I then confirmed both with a second spike, also reverted:

- Two execution tests fail: `tests/agency/ts-helpers/agency-handle-approves-ts-interrupt` and `tests/agency/ts-helpers/agency-handle-rejects-ts-interrupt`. The next section explains why.
- With the keyword's whitespace limited to one line (Task 1, Step 4), the four programs in the "one line" test rows parse as separate statements, for `raise` and for `interrupt`, and the 3,293 unit tests under `lib/parsers`, `lib/backends`, and `lib/preprocessors` pass.

### Behavior that changes

**A call to a function named `raise` becomes an interrupt.** This is a breaking change. Today `raise()` in a value position is a call to whatever function is named `raise`. After this change the parser reads it as the bare raise form, which is `interrupt()`. The two execution tests above do exactly this:

```ts
import { raise } from "./helper.js"

node main() {
  handle {
    return raise()
  } with (i) {
    return approve("from-agency")
  }
}
```

`helper.js` exports a JavaScript function named `raise` that calls `agency.interrupt(...)`. The tests check that an interrupt raised from JavaScript is caught by a `handle` block in the Agency code that called it. After the change `return raise()` no longer calls the helper at all, so the tests fail, and if they passed they would no longer test that contract. Task 1 renames the helper to `raiseFromJs`. These two files are the only places in the repository that call a function named `raise` in a value position.

`interrupt(...)` already works this way, so the new rule matches the old one. But a user's program can change meaning with no error. Task 4 files an issue for refusing a `def` or an import named `raise` or `interrupt`, so that such a program fails to compile. `RESERVED_WORDS` (`lib/parsers/parsers.ts:258`) already lists both words. That check is not part of this plan.

**The keyword and its effect name must be on one line.** `_raiseExprParser` reads the whitespace after `raise` with tarsec's `spaces`, which also matches a line break. `_interruptExprParser` does the same after `interrupt`. So today these two lines are one interrupt with the effect `foo`:

```ts
raise
foo(1)
```

Once `raise` can be a value, the same thing would happen here, where `raise` is a variable:

```ts
const raise = 2
const c = raise
print(c)
```

The second and third lines would become `const c = raise print(c)`, an interrupt with the effect `print`. PR #1406 made "a statement ends at the end of its line" the rule, so Task 1 limits that whitespace to spaces and tabs, for both keywords. After it, both programs above are separate statements.

### What this plan does not fix

An interrupt works as a value only in the positions where the compiler already handles it: the right side of an assignment, a `return`, and a match arm. In two other positions the `interrupt` spelling compiles to broken JavaScript today, and `raise` will do the same:

```ts
const l = label(interrupt feel("q"))        // esbuild: Unexpected "const"
const s = "x ${interrupt feel("q")}"        // esbuild: Unexpected "const"
```

A third position does not parse at all: `"x" + interrupt feel("q")`.

The cause is in `lib/preprocessors/hoistCalls.ts:395`, where a comment says "An interrupt expression is never hoisted as a unit". I tried removing that exception. The two programs above still failed, and five fixture tests broke. So this is its own piece of work in code that every interrupt depends on. Task 4 files an issue for it (issue A). This plan gives `raise` the same reach as `interrupt` and no more.

Two more things stay as they are:

- `return raise x(...)` behaves like `return interrupt x(...)`: the function returns the failure when the interrupt is rejected, and carries on to the next line when it is approved. The type checker models this at `lib/typeChecker/flowBuilder.ts:284`.
- `const msg = raise` with nothing after it on the line still reads a variable named `raise`. The word is in `RESERVED_WORDS`, but the variable parser does not refuse it. That belongs with the issue Task 4 files about reserved names.

## Global Constraints

- Do not hand-edit anything under `docs/site/`.
- Do not edit `CHANGELOG.md`.
- Do not run `agency fmt -i` on a file that already exists.
- Run prettier only on the TypeScript files this plan changes: `npx prettier --write <file>`.
- Save every test run's output to a file under the scratchpad and read the file. Do not rerun a test to see why it failed.
- Run Agency execution tests with the flag CI uses: `pnpm run agency test <file> --check-capabilities`.
- Write commit messages to a file and pass it with `git commit -F <file>`. End each with the attribution line your own session gives you.
- Never amend a commit and never force push.
- The branch is `adit/raise-as-value`, in the worktree `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-batch2`. Run `pnpm run build` there before trusting any test that reads `dist`.
- `pnpm run ast`, `pnpm run fmt`, and `pnpm run agency test` all read `dist`, not the source. A result from before the latest build says nothing about the current source. Build after every source edit and before every one of those commands.

## Review Focus

Each line names an input that no existing test covers and that a person could plausibly write. Each one has a test in the task named at the end of the line. There are seven, not five, because the review added two.

1. A name that starts with `raise`, such as `raiseHand(1)` or `raised`, in a value position. It must stay an ordinary name. (Task 1)
2. `raise` as a value before `with approve`, as in `const a = raise feel("q") with approve`. The handler must wrap the whole assignment. (Task 1)
3. A match arm written inline, `1 => raise feel("q")`. The formatter must keep it inline, and its output must parse again. (Task 2)
4. A match arm written as a block around a `raise`. The formatter must keep the block, as it does today. (Task 2)
5. The answer given to a raised interrupt must arrive in the variable, not just parse. (Task 3)
6. A variable named `raise` on one line with a call on the next line. They must stay two statements. (Task 1)
7. A JavaScript function named `raise`, imported and called. The two existing tests that do this are renamed, and the change in meaning is stated in the pull request. (Task 1, Task 4)

---

### Task 1: The parser accepts `raise` as a value

**Files:**
- Modify: `lib/parsers/parsers.ts:235` (a named same-line whitespace parser), `:4242` (the `baseAtom` list), `:4739` and `:4784` (the whitespace after each keyword), and `:4816` (next to `raiseStatementParser`)
- Create: `lib/parsers/raiseExpression.test.ts`
- Modify: `tests/agency/ts-helpers/agency-handle-approves-ts-interrupt/agent.agency` and `helper.js`
- Modify: `tests/agency/ts-helpers/agency-handle-rejects-ts-interrupt/agent.agency` and `helper.js`

**Interfaces:**
- Consumes: `_raiseExprParser: Parser<InterruptStatement>` (exists, `lib/parsers/parsers.ts:4782`).
- Produces: `export const raiseExprParser: Parser<InterruptStatement>`. Task 2 and Task 3 rely on the parser accepting the forms, not on this name.

- [ ] **Step 1: Rename the JavaScript helper named `raise` in two execution tests**

In both folders named under Files, rename the exported function in `helper.js` from `raise` to `raiseFromJs`, and change the import and the call in `agent.agency` to match. Change nothing else in those files, and do not format them. Then run both, before any parser change:

```bash
pnpm run build > <scratchpad>/raise-0-build.log 2>&1
pnpm run agency test tests/agency/ts-helpers/agency-handle-approves-ts-interrupt/agent.agency --check-capabilities > <scratchpad>/raise-0a.log 2>&1
pnpm run agency test tests/agency/ts-helpers/agency-handle-rejects-ts-interrupt/agent.agency --check-capabilities > <scratchpad>/raise-0b.log 2>&1
```

Expected: both pass. Search once more for any other caller, in case one was added since this plan was written: `grep -rnE "\braise\(\)|import \{[^}]*\braise\b" tests stdlib lib/agents ../ --include=*.agency`. Any hit that is not a raise statement gets the same rename.

- [ ] **Step 2: Write the failing tests**

Create `lib/parsers/raiseExpression.test.ts`. The test compares the two spellings in every position, so a new position or a new form is one more row.

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

/** The lines every test program starts with. */
const PROGRAM_HEAD = [
  "effect feel { }",
  "def raiseHand(count: number): number {",
  "  return count",
  "}",
];

/** The statements of `node main` in a program whose body is `bodyLines`. */
function statementsOf(bodyLines: string[]): any[] {
  const source = [...PROGRAM_HEAD, "node main() {", ...bodyLines, "}", ""].join("\n");
  // Not lowered, so a match is still a matchBlock.
  const parsed = parseAgency(source, {}, false, false);
  if (!parsed.success) {
    throw new Error(parsed.message ?? "parse failed");
  }
  const main = parsed.result.nodes.find((node: any) => node.type === "graphNode") as any;
  return main.body.filter((statement: any) => statement.type !== "newLine");
}

/** The fields that differ between the two spellings for reasons other than
 *  meaning: source positions and the formatter's keyword marker. */
const SPELLING_ONLY_FIELDS = ["loc", "viaRaise"];

function dropSpellingOnlyFields(key: string, value: unknown): unknown {
  if (SPELLING_ONLY_FIELDS.includes(key)) {
    return undefined;
  }
  return value;
}

/** A copy of `tree` with the spelling-only fields removed. */
function meaningOf(tree: unknown): unknown {
  return JSON.parse(JSON.stringify(tree, dropSpellingOnlyFields));
}

/** Each raise form, with the interrupt form that means the same thing. */
const FORMS = [
  { raise: 'raise interrupt("q")', interrupt: 'interrupt("q")' },
  { raise: 'raise interrupt feel("q")', interrupt: 'interrupt feel("q")' },
  { raise: 'raise feel("q")', interrupt: 'interrupt feel("q")' },
  { raise: 'raise std::write("q", {})', interrupt: 'interrupt std::write("q", {})' },
  { raise: 'raise("q")', interrupt: 'interrupt("q")' },
];

/** Each position where the interrupt spelling already parses as a value.
 *  `VALUE` is replaced by the form under test. */
const POSITIONS = [
  { name: "an assignment", lines: ["  const answer = VALUE"] },
  { name: "a return", lines: ["  return VALUE"] },
  { name: "a call argument", lines: ["  print(VALUE)"] },
  {
    name: "a match arm",
    lines: ["  const answer = match (1) {", "    1 => VALUE", "    _ => 0", "  }"],
  },
  { name: "before with approve", lines: ["  const answer = VALUE with approve"] },
];

const ROWS = POSITIONS.flatMap((position) =>
  FORMS.map((form) => ({ ...form, position: position.name, lines: position.lines })),
);

/** `lines` with the placeholder replaced by `form`. */
function withValue(lines: string[], form: string): string[] {
  return lines.map((line) => line.replace("VALUE", form));
}

/** The shape the guide's example has: a raise assigned to a variable, then
 *  a string that uses the variable. Copied here; the test does not read the
 *  guide. */
const RAISE_THEN_TEMPLATE_STRING = [
  '  const msg = raise interrupt("How do you feel?")',
  '  const prompt = "Please categorize the following message: ${msg}"',
  "  return prompt",
];

describe("raise as a value", () => {
  it.each(ROWS)("$raise reads like $interrupt in $position", ({ raise, interrupt, lines }) => {
    const raised = statementsOf(withValue(lines, raise));
    const interrupted = statementsOf(withValue(lines, interrupt));
    expect(raised).toHaveLength(1);
    expect(meaningOf(raised)).toEqual(meaningOf(interrupted));
  });

  it("marks the node so the formatter prints raise", () => {
    const [assignment] = statementsOf(['  const answer = raise feel("q")']);
    expect(assignment.value).toMatchObject({ type: "interruptStatement", viaRaise: true });
  });

  it("reads a raise assignment followed by a template string as separate statements", () => {
    const types = statementsOf(RAISE_THEN_TEMPLATE_STRING).map((statement) => statement.type);
    expect(types).toEqual(["assignment", "assignment", "returnStatement"]);
  });

  it.each([
    {
      name: "a call to a function whose name starts with raise",
      lines: ["  const answer = raiseHand(1)"],
      valueType: "functionCall",
    },
    {
      name: "a variable whose name starts with raise",
      lines: ["  const raised = 1", "  const answer = raised"],
      valueType: "variableName",
    },
  ])("leaves $name alone", ({ lines, valueType }) => {
    const statements = statementsOf(lines);
    expect(statements[statements.length - 1].value.type).toBe(valueType);
  });

  // A keyword and its effect name must be on one line. Otherwise a variable
  // named like the keyword swallows the call on the next line.
  it.each([
    {
      name: "a variable named raise, as a value",
      lines: ["  const raise = 2", "  const answer = raise", "  print(answer)"],
      types: ["assignment", "assignment", "functionCall"],
    },
    {
      name: "a variable named interrupt, as a value",
      lines: ["  const interrupt = 2", "  const answer = interrupt", "  print(answer)"],
      types: ["assignment", "assignment", "functionCall"],
    },
    {
      name: "a bare raise on its own line",
      lines: ["  raise", "  raiseHand(1)"],
      types: ["variableName", "functionCall"],
    },
    {
      name: "a bare interrupt on its own line",
      lines: ["  interrupt", "  raiseHand(1)"],
      types: ["variableName", "functionCall"],
    },
  ])("keeps $name apart from the call on the next line", ({ lines, types }) => {
    expect(statementsOf(lines).map((statement) => statement.type)).toEqual(types);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run lib/parsers/raiseExpression.test.ts > <scratchpad>/raise-1.log 2>&1`

Expected:

- The 20 position rows for the four forms that have a space after `raise`, the marker test, and the template string test fail with a parse error ("the statement before this has ended" or "cannot read the statement").
- The 5 position rows for `raise("q")` fail on the tree comparison, not on a parse error. Today that text parses as a call to a function named `raise`.
- The two "a bare ... on its own line" rows and the "a variable named interrupt, as a value" row fail: the two lines parse as one interrupt.
- The two "leaves alone" rows and the "a variable named raise, as a value" row pass. That last row passes today only because `raise` is not yet a value. It is there to catch the line-break bug once it is.

- [ ] **Step 4: Export `raiseExprParser`, add it to `baseAtom`, and keep each keyword on one line**

In `lib/parsers/parsers.ts`, directly above `raiseStatementParser`, add the export the same way `interruptExprParser` is written on line 4756:

```ts
export const raiseExprParser: Parser<InterruptStatement> = withLoc(_raiseExprParser);
```

In `baseAtom`, add `lazy(() => raiseExprParser),` on the line above `lazy(() => interruptExprParser),`.

Update the comment above `_raiseExprParser`. Its first line says "`raise` raises an interrupt as a statement". Change it to say that `raise` is accepted as a statement and as a value, like `interrupt`.

Next to `optionalSpaces` on line 235, add a named parser for whitespace that stays on one line. Two places in the file already write this inline (lines 4400 and 7816); leave those as they are.

```ts
/** One or more spaces or tabs. Unlike `spaces`, it does not cross a line
 *  break, so a keyword and what follows it must share a line. */
const sameLineSpaces = many1(oneOf(" \t"));
```

Use it in place of `spaces` in two places: after `str("interrupt")` in the structured form of `_interruptExprParser` (line 4739), and in `const head = seqC(str("raise"), spaces)(input);` in `_raiseExprParser` (line 4784). Above the `raise` use, add a comment that says why: with `spaces`, a variable named `raise` at the end of a line would join the call on the next line into one interrupt.

- [ ] **Step 5: Run the tests and confirm they pass**

Run:

```bash
npx vitest run lib/parsers lib/backends lib/preprocessors > <scratchpad>/raise-2.log 2>&1
pnpm run build > <scratchpad>/raise-2-build.log 2>&1
pnpm run agency test tests/agency/ts-helpers/agency-handle-approves-ts-interrupt/agent.agency --check-capabilities > <scratchpad>/raise-2a.log 2>&1
pnpm run agency test tests/agency/ts-helpers/agency-handle-rejects-ts-interrupt/agent.agency --check-capabilities > <scratchpad>/raise-2b.log 2>&1
```

Expected: every unit test file passes, including the new one, and both execution tests pass. If a fixture breaks because it has `interrupt` or `raise` at the end of one line and the effect name on the next, do not rewrite the fixture. Stop and report it, because that would be a program this change breaks that the plan did not know about.

If the "a call argument" rows fail to parse for the `raise("q")` form, the cause is ordering inside `baseAtom`: a function-call parser is reading `raise(` first. `interruptExprParser` is already ahead of those parsers, so placing the new entry directly above it avoids this.

- [ ] **Step 6: Commit**

```bash
npx prettier --write lib/parsers/parsers.ts lib/parsers/raiseExpression.test.ts
pnpm run typecheck
git add lib/parsers/parsers.ts lib/parsers/raiseExpression.test.ts tests/agency/ts-helpers/agency-handle-approves-ts-interrupt tests/agency/ts-helpers/agency-handle-rejects-ts-interrupt
git commit -F <scratchpad>/msg-1.txt
```

Message subject: `Parser: raise can be written as a value, like interrupt`.

---

### Task 2: The formatter prints an inline `raise` arm inline

**Files:**
- Modify: `lib/backends/agencyGenerator.ts:1707-1711`
- Modify: `lib/backends/agencyGenerator.matchBlock.test.ts:104-146`

**Interfaces:**
- Consumes: the parser from Task 1, which now accepts `1 => raise feel("q")`.
- Produces: nothing a later task uses.

`armPrintsInline` refuses to print a `raise` arm on one line because `=> raise ...` used to fail to parse. After Task 1 it parses, so the branch protects against nothing and makes `raise` behave differently from `interrupt` for no reason. An arm the author wrote as a block still prints as a block, because the `blockBody` check above the branch decides that.

- [ ] **Step 1: Write the failing test**

In `lib/backends/agencyGenerator.matchBlock.test.ts`, add one row to the `round-trips:` table, after the "interrupt-expression arm stays inline" row:

```ts
    [
      "raise-expression arm stays inline",
      [
        "node main() {",
        "  match(x) {",
        '    "a" => raise("ask")',
        "    _ => 0",
        "  }",
        "}",
      ].join("\n"),
    ],
```

Change the comment above the "raise-statement arm keeps its block" row. It says the arm grammar does not accept a `raise`. Replace it with: the author wrote a block, so the formatter keeps the block.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/backends/agencyGenerator.matchBlock.test.ts > <scratchpad>/raise-3.log 2>&1`

Expected: the new row fails. The formatted text has the arm as a block, `"a" => {`, `raise("ask")`, `}`.

- [ ] **Step 3: Remove the `viaRaise` branch from `armPrintsInline`**

Delete lines 1707 to 1711 of `lib/backends/agencyGenerator.ts`: the two comment lines and the `if (stmt.type === "interruptStatement" && ... .viaRaise) { return false; }` block. If `InterruptStatement` is then imported in that file and no longer used, remove the import.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run lib/backends > <scratchpad>/raise-4.log 2>&1`

Expected: every file under `lib/backends` passes. The "raise-statement arm keeps its block" row must still pass. If it fails, the parser is not recording `blockBody` for that arm, and the branch has to stay; stop and report that.

- [ ] **Step 5: Commit**

```bash
npx prettier --write lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.matchBlock.test.ts
pnpm run typecheck
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.matchBlock.test.ts
git commit -F <scratchpad>/msg-2.txt
```

Message subject: `fmt: an inline raise arm stays inline`.

---

### Task 3: An execution test that the answer reaches the variable

**Files:**
- Create: `tests/agency/interrupts/raiseAsValue.agency`
- Create: `tests/agency/interrupts/raiseAsValue.test.json`

**Interfaces:**
- Consumes: the parser from Task 1.
- Produces: nothing a later task uses.

The parser tests show that the two spellings give the same tree. This test shows that the tree does what the guide says: the answer becomes the value.

No existing execution test puts an interrupt in a match arm, for either keyword, so `viaMatchArm` is the first test of that path. If it fails, replace `raise` with `interrupt` in that one function and run again before looking at the parser change. If the `interrupt` spelling fails the same way, the fault is older than this plan: stop and report it.

- [ ] **Step 1: Write the test program**

`tests/agency/interrupts/raiseAsValue.agency`:

```ts
// `raise` as a value: the answer to the interrupt becomes the value, in each
// position where the `interrupt` spelling already works.
effect feel { }

def viaAssignment(): string {
  const answer = raise feel("How do you feel?")
  return "assigned: ${answer}"
}

def viaMatchArm(): string {
  const answer = match (1) {
    1 => raise feel("How do you feel?")
    _ => "no"
  }
  return "arm: ${answer}"
}

node raiseAsValue() {
  handle {
    const parts = [viaAssignment(), viaMatchArm()]
    return parts.join(", ")
  } with (intr) {
    return approve("happy")
  }
}
```

`tests/agency/interrupts/raiseAsValue.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "raiseAsValue",
      "description": "The answer to a raise used as a value becomes the value",
      "input": "",
      "expectedOutput": "\"assigned: happy, arm: happy\"",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ]
    }
  ]
}
```

The expected output is written before the first run. Compare the run against it; do not copy the run's output into the file.

- [ ] **Step 2: Build and run the test**

Run:

```bash
pnpm run build > <scratchpad>/raise-build.log 2>&1
pnpm run agency test tests/agency/interrupts/raiseAsValue.agency --check-capabilities > <scratchpad>/raise-5.log 2>&1
```

Expected: one test, passing.

- [ ] **Step 3: Confirm the test can fail**

Temporarily remove the `lazy(() => raiseExprParser),` line from `baseAtom`, run `pnpm run build`, and run the test again into `<scratchpad>/raise-6.log`. Make this edit by hand. Do not use `git stash`, because the stash list is shared between worktrees.

Expected: the test fails with a parse error on line 6 of the program. Put the line back, rebuild, and rerun to confirm the pass. `git status` must then show no change to `lib/parsers/parsers.ts`.

- [ ] **Step 4: Commit**

```bash
git add tests/agency/interrupts/raiseAsValue.agency tests/agency/interrupts/raiseAsValue.test.json
git commit -F <scratchpad>/msg-3.txt
```

Message subject: `Test that the answer to a raise used as a value becomes the value`.

---

### Task 4: The dev doc, two issues, and the pull request

**Files:**
- Create: `docs/dev/language/interrupt-as-value.md`
- Modify: `CLAUDE.md` (a new index line under "Language semantics and syntax features", after the line for `match-expression-positions.md`)
- Modify: `.claude/skills/agency-language-docs/SKILL.md` (the same index line, in the same place)

**Interfaces:**
- Consumes: the behavior from Tasks 1 to 3.
- Produces: the pull request.

- [ ] **Step 1: File two issues**

Search first, so neither is a duplicate: `gh issue list --search "interrupt nested argument" --state open` and `gh issue list --search "reserved raise interrupt name" --state open`. Write each body to a file in the scratchpad and pass it with `--body-file`.

Issue A, title `An interrupt nested in a call argument or a string compiles to broken JavaScript`. The body states, in this order: the three programs from "What this plan does not fix" above; what each does today (two fail in esbuild with `Unexpected "const"` at `const __response = __run.ctx.getInterruptResponse(...)`, one fails to parse); that both spellings are affected; that the cause is the exception at `lib/preprocessors/hoistCalls.ts:395`; and that removing the exception alone does not fix it and breaks five fixture tests (`interrupt-2-deep-in-function`, `interrupt-assignment`, `interrupt-in-node`, `withModifier`, and the preprocessor fixture `interrupt`). It ends with the two ways out: lift a nested interrupt into a temporary, or refuse the position with a diagnostic that tells the author to assign the interrupt to a variable first.

Issue B, title `Refuse a def, an import, or a variable named raise or interrupt`. The body states: that `raise(...)` and `interrupt(...)` in any position are interrupts, so a function with either name can be declared or imported and never called; the program from "Behavior that changes" as the example; that the call changes meaning with no error; that `RESERVED_WORDS` in `lib/parsers/parsers.ts` already lists both words but the `def`, import, and variable parsers do not refuse them; and that `const raise = 2` parses today.

- [ ] **Step 2: Write the dev doc**

Create `docs/dev/language/interrupt-as-value.md`, titled `# An interrupt as a value`. `docs/dev/language/match-expression-positions.md` answers the same question for `match` and is the model for its shape. The doc says, in plain sentences with one example each:

1. Both spellings, `interrupt` and `raise`, are entries in `baseAtom` in `lib/parsers/parsers.ts`, so both parse wherever an expression can start. They produce the same node. `viaRaise` only tells the formatter which keyword to print.
2. The value is the answer given to the interrupt. It is delivered in three positions: the right side of an assignment, a match arm, and a `return`. A `return` is different: when the interrupt is approved the function carries on to the next line (name `lib/typeChecker/flowBuilder.ts`).
3. Nested inside a call argument or a string, an interrupt parses and then compiles to broken code. Give the number of issue A.
4. `raise(...)` and `interrupt(...)` are always interrupts, so a function named `raise` or `interrupt` cannot be called. Give the number of issue B.
5. The keyword and its effect name must be on one line, and why: `sameLineSpaces` in `lib/parsers/parsers.ts`, with the three-line example from "Behavior that changes".

The doc describes the mechanism and the rules. It does not tell the story of this change.

The index line, the same text in both files:

```
- `docs/dev/language/interrupt-as-value.md` — `interrupt` and `raise` as values: the one parser entry each, the three positions where the answer is delivered and how `return` differs, the nested positions that do not compile, why a function named `raise` cannot be called, and why the keyword and its effect name must share a line.
```

- [ ] **Step 3: Run the checks that cover the whole repository**

```bash
pnpm run typecheck > <scratchpad>/raise-tc.log 2>&1
pnpm run lint:structure > <scratchpad>/raise-lint.log 2>&1
npx vitest run lib/sourceIsText.test.ts lib/parsers lib/backends lib/typeChecker lib/preprocessors lib/utils > <scratchpad>/raise-unit.log 2>&1
```

Expected: all three exit 0.

- [ ] **Step 4: Commit, push, and open the pull request**

```bash
git add docs/dev/language/interrupt-as-value.md CLAUDE.md .claude/skills/agency-language-docs/SKILL.md
git commit -F <scratchpad>/msg-4.txt
git push -u origin adit/raise-as-value
gh pr create --title "raise can be written as a value, like interrupt" --body-file <scratchpad>/pr-raise.md
```

The pull request body states: what changed for a person writing Agency (one before and after example); that this is a breaking language change, in two ways, each with its example from "Behavior that changes" (a call to a function named `raise` is now an interrupt, and a keyword no longer joins an effect name on the next line); the two tests whose helper was renamed and why; that the guide and `CLAUDE.md` examples now work as written; the three positions where the value arrives; the nested positions that do not work, with the number of issue A; the number of issue B; and the behavior that is unchanged (`return raise`). It ends with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Do not merge. The owner's review agent reviews the pull request and the owner merges it.
