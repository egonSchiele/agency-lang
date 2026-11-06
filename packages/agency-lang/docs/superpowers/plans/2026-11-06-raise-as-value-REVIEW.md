# Review of `2026-11-06-raise-as-value.md`

The design is right. `raise` and `interrupt` already make the same node, so adding one entry to `baseAtom` is the smallest change that makes the guide's example true. I checked the plan's line numbers and claims against the worktree at `c0f0f91ac`, and ran the parser on small programs. Most claims hold. Two findings change what the plan has to do, and the rest are small.

## Must fix before executing

### 1. Two existing execution tests call a JavaScript function named `raise`, and this change turns those calls into interrupts

`tests/agency/ts-helpers/agency-handle-approves-ts-interrupt/agent.agency` and its sibling `agency-handle-rejects-ts-interrupt/agent.agency` both read:

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

`helper.js` exports an `async function raise()` that calls `agency.interrupt(...)` from JavaScript. These two tests pin an important contract: an interrupt raised from TypeScript is caught by a `handle` block in the Agency code that called it.

Today `raise()` in a value position is a call to that imported function. After Task 1, `_raiseExprParser`'s bare form (`str("raise")` followed by an argument list, `parsers.ts:4802`) matches `raise()` first, so the line becomes `return interrupt()`. The handler approves it, a `return interrupt` that is approved carries on to the next line, the block ends, and `main` no longer returns `{"type":"approve","value":"from-agency"}`. Both tests will fail in CI. If they happened to pass, they would no longer test the contract.

The spike missed this because it ran only the unit tests under `lib/`. I searched every `.agency` and `.md` file in the repository for `raise` in a value position. These two files are the only code hits.

What the plan should add:

- A step in Task 1 that renames the helper in both tests, for example to `raiseFromJs`, in `helper.js` and in both `agent.agency` files. Run both tests after the rename.
- A line in "What this plan does not fix" (or a new "Behavior that changes" section) and in the PR body that says this is a breaking change. Any program that calls a function named `raise`, whether imported from JavaScript or defined with `def`, now raises an interrupt at that call. `interrupt(...)` already works this way, so the new rule matches the old one, but a user's program can change meaning without an error.
- Optional, and probably a separate issue: refuse a `def` or an import whose name is `raise` or `interrupt`, so that a program like the one above fails to compile and does not silently change what it does. `RESERVED_WORDS` (`parsers.ts:258`) already lists both words, so the check has a list to read from.

This also corrects Task 1, Step 2. The five `raise("q")` rows do not fail with a parse error before the change. They parse as a call to a function named `raise`, so they fail on the tree comparison. The test is still correct. Only the stated expectation is wrong.

### 2. The keyword reads across a line break, so `const x = raise` followed by a call on the next line becomes one interrupt

`_raiseExprParser` reads the keyword with `seqC(str("raise"), spaces)`. Tarsec's `spaces` matches newlines (`space` is `oneOf(" \t\n\r")`, `node_modules/tarsec/dist/parsers.js:288`). The `dist` in this worktree still holds the spike (see the note at the end), so I could run the changed parser. This program:

```ts
node main() {
  const raise = 2
  const c = raise
  print(c)
}
```

parses `const c = raise` and `print(c)` as one assignment whose value is `interruptStatement` with effect `print`. The plan says "`const msg = raise` with nothing after it still reads a variable named `raise`". That is true only when the next line does not start with a name and `(`.

The same thing already happens with `interrupt` in a value position and with `raise` in a statement position. I confirmed both on the current parser: `raise` on one line followed by `foo(1)` on the next parses as `raise foo(1)`. So this is not new, but the plan carries it into a new position, and #1406 has just made "a statement ends at the end of its line" the rule.

Recommendation: in `_raiseExprParser`, read the space after `raise` with `many1(oneOf(" \t"))` and not `spaces`. The same form is used at `parsers.ts:4400` and `parsers.ts:7816`. Add one test row: a variable named `raise` on one line followed by `print(...)` on the next must give two statements. If you prefer to leave `interrupt` alone in this PR, add the `interrupt` case to the issue Task 4 files. Whichever you pick, correct the sentence in "What this plan does not fix".

## Smaller points

### 3. The dev doc section belongs under `docs/dev/language/`

Task 4 adds "Where an interrupt can be a value" to `docs/dev/runtime/interrupts.md`. That doc's index line is "How a program resumes in the middle of a block after an interrupt, using step counters". The new section is about the parser and the positions where codegen delivers the value. `docs/dev/language/match-expression-positions.md` is the closest existing doc: it answers "where may a `match` appear as a value". A short new `docs/dev/language/interrupt-as-value.md`, or a section in `with-approve.md` or `effect-patterns.md`, fits better. If it becomes a new doc, the index entry goes under "Language semantics" in `CLAUDE.md` and in `.claude/skills/agency-language-docs/SKILL.md`, and not in the runtime skill.

The section should also state the rule from finding 1 (a call to a function named `raise` is an interrupt) and the same-line rule from finding 2.

### 4. The "guide example" test does not read the guide

`GUIDE_EXAMPLE` copies two of the guide's lines into the test. If the guide changes, the test keeps passing. That is fine, since `docs/site/` is generated and the test must not depend on it. Rename the test to say what it checks, for example "reads `const msg = raise interrupt(...)` followed by a template string as separate statements", so a reader does not assume it reads the guide file.

### 5. No existing execution test puts an interrupt in a match arm

The plan says an interrupt in a match arm delivers its value, and Task 3 tests that with `raise`. I found no execution test under `tests/agency/` with `=> interrupt`. The parser lowers the arm to `const __armval_N = interrupt ...`, which is an ordinary assignment, so it should work. Task 3 is the first test of that path for either keyword. If it fails, check whether the `interrupt` spelling fails the same way before you look at the `raise` change.

### 6. The `dist` in this worktree still contains the spike

`dist/lib/parsers/parsers.js:2408` has `lazy(() => raiseExprParser)` in `baseAtom`. The spike was reverted in source only. Anything that reads `dist` before the next `pnpm run build`, such as `pnpm run ast` or `pnpm run agency test`, already behaves as if Task 1 were done. Task 3 builds before it runs, so the plan is safe as written. Add a line to Global Constraints so nobody trusts an earlier `dist` result, and so Task 3 Step 3 really starts from a clean build.

### 7. The commit trailer names a fixed model

Global Constraints says to end each commit with `Co-Authored-By: Claude Fable 5.1`. The executor should use the attribution line its own session gives it.

## Claims I checked that hold

- `baseAtom` at `parsers.ts:4226`, with `interruptExprParser` at line 4242. No parser above it can consume `raise`.
- `_raiseExprParser` at `parsers.ts:4782`, with five forms, used only by `raiseStatementParser`.
- `raiseHand(1)` parses as `functionCall`, and `raised` parses as `variableName`. The head fails on the missing space and the bare form fails on the missing `(`.
- `armPrintsInline` at `agencyGenerator.ts:1699`. The `blockBody` check comes before the `viaRaise` branch, so removing the branch keeps a block arm as a block. `InterruptStatement` is still used at line 645 after the branch is removed, so the import stays.
- `return interrupt` falls through on approval (`flowBuilder.ts:284`).
- The exception at `hoistCalls.ts:395`.
- `parseAgency(source, {}, false, false)` matches the signature at `lib/parser.ts:283`. The program root has `nodes`, and a node is `graphNode`.
- `effect feel { }` with no namespace parses, and `return` inside a `handle` block inside a node parses.
- The `.test.json` shape in Task 3 matches `tests/agency/interrupts/interruptAssignmentApprove.test.json`.
