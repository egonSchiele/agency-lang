# Review: Agent-Friendly Syntax Variations Implementation Plan

Reviewing `2026-07-31-agent-friendly-syntax-variations.md`.

## Summary

This plan resolves all three findings from the spec review, and resolves them
well. The range syntax question is settled (infix, with the bracketed form
turned into an explicit error rather than left silently wrong). The number-parser
fix is now correctly framed as a boundary rule with a working implementation. The
doubled-arrow case in section 2 gets four dedicated test pairs. The plan also
picked up the smaller notes — `function` as a breaking change in the changelog,
the formatter fixture check, the prelude/shadowing check, and the execution test.

The task decomposition is good: Task 1 is separated out as an independent bug fix,
the one real ordering constraint (Task 5 before Task 6) is called out and
explained, and each task states what it consumes and produces.

I verified the plan's code claims against the source. Most are right. **Three are
wrong in ways that will cost the implementer time**, and one design decision has a
bug I can demonstrate by inspection. Details below, most serious first.

A separate pass against `docs/dev/anti-patterns.md` follows the numbered findings.
It turned up two more things worth fixing before execution: the plan hand-writes a
test helper the repo already provides as a global matcher, and Task 5's number
parser is written imperatively in a codebase whose parsers are declarative.

A third pass reviews the tests themselves. That one is the most serious of the
three: **`parseAgency` returns a result instead of throwing**, which I confirmed
against the built parser, so most of the plan's failure assertions cannot pass and
three of them pass no matter what the code does.

---

## 1. Task 7 registers the probe in the wrong parser

The plan says (Task 7, Files and Step 3) to register `bracketedRangeParser` in
"the literal alternatives list" at `lib/parsers/parsers.ts:2274`, immediately
before `lazy(() => agencyArrayParser)`.

Line 2274 is inside **`staticTagArgParser`**, which is declared at `:2270`. That
parser handles the statically-known argument subset allowed inside validation tags
such as `@validate(...)`. It is not the expression path.

The consequence is that `const r = [3..6]` in ordinary code would not hit the
probe at all — it would parse as a one-element array, silently, which is the exact
outcome Task 7 exists to prevent. The error would only fire inside a tag argument.

`agencyArrayParser` is registered in three places:

| Line | Context |
|---|---|
| 2274 | `staticTagArgParser` — tag arguments only (what the plan cites) |
| 2780 | inside a comprehension-related alternative |
| **3316** | the expression atom list — this is the one |

Line 3316 is the right target. Note the ordering comments immediately above it at
`:3297-3315`: several parsers **must** precede `agencyArrayParser` because it
would otherwise consume the opening `[`, and `comprehensionParser` is one of them.
Whatever position the probe takes has to respect that existing ordering, and the
plan's regression step for comprehensions (Task 7 Step 5) is well chosen because
of it.

---

## 2. The bracketed-range check rejects valid code

Task 7 Step 3 settles on this test, run over the source text the probe consumed:

```ts
const consumed = input.slice(0, input.length - probed.rest.length);
if (!/[^.]\.\.[^.]/.test(consumed)) return failure("", input);
```

This searches the raw source for `..`, which means it cannot tell code from data.
Walk `const r = ["a..b"]` through it:

1. `char("[")` matches.
2. `exprParser` parses the string literal `"a..b"`.
3. `char("]")` matches. The probe succeeds.
4. `consumed` is `["a..b"]`.
5. The regex looks for non-dot, `..`, non-dot. The literal's own text supplies
   `a..b`. It matches.
6. `committedFailure` fires.

So an array holding one string that happens to contain two dots is a compile
error. `[f("a..b")]` and `["x" + "a..b"]` fail the same way. Two dots inside a
comment in that span would do it too.

I want to be careful about what I am claiming: this is reasoning from the code as
written, not a measurement, because the change is unimplemented. But the path is
short and I do not see anything that would stop it.

The plan's own Anti-Pattern Audit names the principle this violates — "No parallel
mechanism." Re-deriving parse structure by pattern-matching the source text is a
second mechanism for something the parse already determined.

The plan is honest about why it reached for the regex: "a hand-written
`range(3, 6)` produces the identical node," so the AST genuinely cannot
distinguish the two. That constraint is real and it comes straight from the design
rule that the AST forgets the spelling. But the way out is structural, not
textual. Two options:

**Option A, parse the element with a range-free parser.** The problem is only that
`exprParser` swallows `3..6` whole, so the `..` is gone before the probe can look
for it. Parsing the left operand with the precedence level just tighter than range
makes the shape detectable structurally: `[`, tight-expr, `..`, tight-expr, `]`.
`[3..6, 8..9]` fails at the closing bracket and stays legal, `["a..b"]` never
reaches the `..` step. This needs `buildExpressionParser` to expose a
sub-level parser, which I did not verify — worth checking before committing to it.

**Option B, reconsider erroring at all.** `[3..6]` is what models actually write —
it is the Haskell and CoffeeScript spelling, and it is what the spec's own
examples used throughout before this plan changed them. The spec's premise is to
accept unambiguous guesses. Treating a lone bracketed range as a range is
unambiguous. The cost is that `[1, 3..6]` and `[3..6]` then mean structurally
different things, which is a real wart. I lean toward keeping the error, but the
plan presents it as forced by the infix reading when it is a choice, and it is the
choice most likely to annoy the exact audience this work is for.

Either way, the current rule has a surprising edge: `[3..6]` is an error, and
adding an element to make `[1, 3..6]` silently fixes it. Whichever option wins,
that deserves a line in the docs.

---

## 3. The formatter fixture check does not run anything

Task 10 Step 1:

```bash
pnpm test:run tests/formatter 2>&1 | tee /tmp/t10.txt
```

I ran this. It does not check the fixtures — it fails to find any tests:

```
No test files found, exiting with code 1
filter: tests/formatter
exclude: **/node_modules/**, **/dist/**, tests, .worktrees/**, runs/**, **/*.perf.test.ts
```

Two independent reasons. `vitest.config.ts:20` excludes the whole `tests/` tree
from the default unit run. And `tests/formatter/` holds no test files anyway — it
contains `roundtrip.agency` and `generics.agency`, which are Agency **fixtures**,
not tests.

The tests that consume them live in `lib/formatter.test.ts`, at `:141` and `:185`.
So the step should be:

```bash
pnpm test:run lib/formatter.test.ts 2>&1 | tee /tmp/t10.txt
```

This one matters more than a typo because of what the step is for. The plan says
the check confirms no variation leaked into the AST, and tells the implementer to
"note that explicitly in the PR description" when it passes. As written it exits
non-zero, so an implementer either reports a failure that is not real or, worse,
sees "no test files" and waves it through as nothing to check.

---

## 4. Task 8 cannot pass without a build step

Task 8 runs the execution test with:

```bash
pnpm run agency test tests/agency/range.agency
```

`pnpm run agency` is `node ./dist/scripts/agency.js`. Every parser change in
Tasks 1 through 7 edits `lib/parsers/parsers.ts`, which is TypeScript — `dist/`
does not update on its own. Run as written, immediately after Task 7, this
exercises a build that predates the range operator, so `3..6` still parses as the
old malformed number and the test fails for a reason that has nothing to do with
the code under test.

Task 8 needs a `make` step before Step 3. Worth stating why in the plan, since the
preceding seven tasks all use vitest, which reads TypeScript sources directly and
never needs a build. That asymmetry is the trap.

The `.test.json` format in Step 2 is correct — I compared it against
`tests/agency/agency-review.test.json` and the `nodeName` / `input` /
`expectedOutput` / `evaluationCriteria` shape matches exactly.

---

## Smaller notes

**`docs:build` does not exist.** Task 9 Step 5 runs `pnpm run docs:build` and
hedges with "If there is no such script, check `package.json`." There is no
docs-related script at all. The guide markdown is staged into `stdlib/docs/` by a
plain `cp -r` in the Makefile (`:31-38`), with no link checking. So there is
nothing to verify beyond reading the diff. Better to drop the step than leave the
implementer hunting for a command that is not there.

**`makeRangeCall` drops `loc`.** The builder in Task 6 Step 3 returns `type`,
`functionName`, and `arguments`. I confirmed this matches what
`parseAgency("range(3, 6)")` produces, so the AST-equality tests will pass — they
strip `loc` from both sides. But every node the parser builds normally carries a
`loc`, and this one will not. Anything downstream that reports a position for a
range — a typechecker diagnostic on a bad endpoint, a formatter comment
attachment — has nothing to point at. Since `makeRangeCall` receives `left` and
`right`, it can synthesize a span from their locations cheaply. Worth doing, and
worth a test that a type error inside a range reports a sane line.

**The nested-declaration error message will be stale.** Task 1 makes
`bodyDeclarationParser` catch `function`, but leaves `BODY_DECLARATION_MESSAGE`
saying "`node` and `def` declarations are only legal at the top level of a file."
An agent that wrote `function` gets told about `def`. One-word fix, and the whole
point of this work is the quality of the feedback loop.

**Task 7 shows two versions of the same parser.** Step 3 presents a first version,
explains its flaw, then presents a second and says "Use the second version." For a
plan meant to be executed task-by-task, possibly by an agent, the discarded
version is a hazard — it is the first code block under the step. Keep the
reasoning, show only the code to write.

**Task 5's `1.2.3` expectation is an assumption.** The unit test asserting
`numberParser("1.2.3")` returns `1.2` with rest `.3` will hold. The last one,
`expect(() => parseAgency("node main() { const x = 1.2.3 }")).toThrow()`, depends
on what the surrounding expression parser does with a leftover `.3` — plausibly a
member-access attempt that fails, but the plan does not say. Fine to keep as a
test; just do not be surprised if it needs its expectation adjusted, and do not
adjust the parser to satisfy it without thinking.

**Precedence is right.** I checked the operator table at `:3437`. Levels run
highest-precedence-first, additive is 5 and relational is 4, and every entry
already carries an `apply` hook that can return any `Expression` — `makeBinOp`
(`:3364`) is just the common case. So a new level between them, with an `apply`
that builds a call instead of a `binOpExpression`, fits the existing machinery
exactly as the plan describes. `wsOp` and `oneOfStr` (`:286`) both exist. This is
the load-bearing assumption of the whole range design and it holds.

---

## Anti-pattern audit

Checked against `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md`,
looking at every production code block the plan proposes.

### Task 5 is imperative where the codebase is declarative

This is the most substantive of the two, and it is worth looking at closely
because it inverts the approach the rest of the file takes.

This parser is built on tarsec, a combinator library — a **declarative** grammar
where you state what a construct looks like and the library does the scanning. The
plan keeps the existing, wrong grammar:

```ts
many1WithJoin(or(char("-"), char("."), char("_"), digit))
```

which says "any run of dashes, dots, underscores and digits" — a description that
was never true of numbers. It then bolts on an imperative character loop with a
mutable flag to undo the over-match:

```ts
let seenDot = false;
for (let i = 0; i < raw.length; i++) {
  if (raw[i] !== ".") continue;
  const nextIsDigit = /[0-9]/.test(raw[i + 1] ?? "");
  if (seenDot || !nextIsDigit) return raw.slice(0, i);
  seenDot = true;
}
```

The *what* — a number is an optional sign, then digits, then optionally one dot
followed by at least one digit — is never stated anywhere. Only the *how* of
scanning and truncating. That is the catalog's "Imperative code everywhere" entry:
the logic for the what and the logic for the how should be split apart, so a later
change touches only the what.

Stated in the surrounding idiom, the rule becomes the code:

```ts
seqC(
  optional(char("-")),
  many1WithJoin(or(digit, char("_"))),
  optional(seqC(char("."), many1WithJoin(or(digit, char("_"))))),
)
```

The parser now stops in the right place *by construction*. `3..6` splits correctly
with no post-processing, and `1.2.3` stops after `1.2` for the same reason.

Two consequences follow from the imperative version that this one does not have.

**It reaches around the combinator's bookkeeping.** `rest: input.slice(prefix.length)`
recomputes by hand what the library already tracks — the "Leaky abstractions"
entry, with the caller reconstructing internal state.

**It creates a coupling that has to be explained in prose.** From Task 5 Step 3:
"The underscore strip moved out of the `capture` map so that `numericPrefix` scans
the raw text and `prefix.length` still indexes into `input` correctly." A paragraph
explaining why two things must stay in sync is the signal to restructure, not to
add the paragraph.

Smaller hits in the same block: `let seenDot` against the standards' "Prefer
`const` over `let`", the single-character `i`, and `/[0-9]/` written inline twice.

### The plan duplicates a helper the repo already provides

Tasks 2, 3, 4, 6 and 7 all tell the implementer to hand-write a `stripLocs`
helper. Task 4 is explicit: "copy the helper into each test file that needs it
rather than exporting it, matching how these co-located test files are already
written."

That description of the local convention is backwards. `lib/parsers/vitest.setup.ts`
registers a global custom matcher, **`toEqualWithoutLoc`**, available in every test
file with no import because it is the `setupFiles` entry for the whole vitest run.
It is used in 23 test files, including three of the four this plan targets:

| File | existing `toEqualWithoutLoc` uses |
|---|---|
| `lib/parsers/function.test.ts` | 9 |
| `lib/parsers/literals.test.ts` | 11 |
| `lib/parsers/matchBlock.test.ts` | 3 |
| `lib/parsers/blockArgument.test.ts` | 0 |

This is the catalog's first entry, "Duplicating existing code," and it has a
practical consequence rather than only a tidiness one. The existing matcher's
`normalize` strips **three** things: `loc`, `delimiter`, and `newLine` nodes. The
hand-rolled version strips only `loc`. Every AST-equality assertion in this plan
compares two *whole-program* parses of different source text, which is exactly
where stray newline nodes appear — so the weaker helper can fail a correct
implementation.

Replace every `expect(stripLocs(a)).toEqual(stripLocs(b))` with
`expect(a).toEqualWithoutLoc(b)`, and do not write the helper at all.

### Smaller

**The Task 7 regex is a leaky abstraction as well as a bug.** Finding 2 above
covers the correctness problem. In catalog terms it is two entries at once:
reconstructing the consumed span by hand (`input.length - probed.rest.length`) is
the leaky-abstraction pattern, and re-deriving by regex what the parser already
determined is duplicated work. The declarative statement is "an array literal whose
sole element is a range" — a structural property, not a text pattern.

**`as Expression` in `makeRangeCall`** is a double cast (`as const` inside,
`as Expression` outside) that silences the one question worth answering: does this
node shape satisfy `FunctionCall`? The plan defers it to a test instead. I checked
`lib/types/function.ts:80` and the three fields are sufficient, so dropping the
cast costs nothing and lets the compiler answer directly.

**Two versions of the same parser in Task 7 Step 3** is the "Inconsistent patterns"
concern turned on the plan itself — the discarded version is the first code block
under the step.

**One-line `if`s** appear in both new blocks. The catalog lists these, but the
surrounding file already uses that style heavily (`if (!result.success) return result;`
is in the current `numberParser`). Matching local style is right here; noted only
for completeness.

### What is clean

The range work gets the altitude right where it matters most. Adding a row to the
operator table at `:3437` — a declarative table where each entry names an operator,
an associativity, and an `apply` hook — is the correct move, and `makeRangeCall`
mirroring the existing `makeBinOp` (`:3364`) is the consistent pattern. Lowering to
a `range()` call rather than inventing a `rangeExpression` node deliberately avoids
the parallel-mechanism trap, and the plan's own Anti-Pattern Audit section names
that risk correctly.

Also clean: `BRACKETED_RANGE_MESSAGE` as a named constant rather than an inline
string, `bracketedRangeParser` following `bodyDeclarationParser`'s established
`Parser<never>` shape, and no dynamic imports, swallowed catch blocks, or nested
ternaries anywhere.

The pattern across the plan is that **the range work is well-abstracted and the
number-literal work is not.**

---

## Test-plan audit

Separate question from whether the plan's *production* changes are right: do the
tests test what they claim, would they fail if the code broke, and what is missing?

I ran the plan's assertion styles against the built parser rather than reasoning
about them. The short answer is that **most of the failure assertions do not work**,
and three of them pass no matter what the code does.

### `parseAgency` does not throw, so every throw-based assertion is wrong

`parseAgency` lives in `lib/parser.ts:273` and returns a `ParseAgencyResult`. A
recoverable parse failure comes back as `{ success: false, message }`. It does not
throw. I checked five inputs through the built parser:

| Input | Result |
|---|---|
| nested `def` in a body (Task 1's control case) | **returned** `success: false` |
| nested `function` in a body (Task 1's target) | **returned** `success: true` |
| `const x = 1.2.3` (Task 5) | **returned** `success: true` |
| a valid program | returned `success: true` |
| complete garbage (`const = = =`) | **returned** `success: false` |

Nothing threw, including the garbage. That breaks the plan's assertions in two
opposite directions.

**`toThrow` assertions can never pass.** Task 1 asserts
`expect(() => parseAgency(src)).toThrow(/only legal at the top level/)` for both
the `function` case and the `def` control. Neither throws, so both fail — before
*and* after the fix. The plan's Step 2 expectation, "the `function` case FAILS, the
`def` case PASSES," never happens; both fail, which reads like the probe is broken
when it is fine. Task 5's `1.2.3` assertion and Task 7's `[3..6]` assertion have
the same problem.

Task 7's second test is worse than failing. It wraps the call in `try`/`catch` and
asserts on the caught message. The `catch` never runs, so `message` stays `""` and
both `toContain` assertions fail with no hint about why.

**`not.toThrow` assertions pass vacuously.** Three tests are built on this —
Task 4's match-guard adjacency case and Task 6's "keeps `.`, `..` and `...`
distinct" trio. Since `parseAgency` returns rather than throws even for
`const = = =`, these pass for *any* input. They cannot fail. They are testing
nothing at all.

The fix throughout is to assert on the returned result:

```ts
const parsed = parseAgency(src);
expect(parsed.success).toBe(false);
expect(parsed.message).toMatch(/only legal at the top level/);
```

and for the positive cases, `expect(parseAgency(src).success).toBe(true)`.

### `parseAgency` is imported from the wrong module

Task 1 Step 1 says "add it from `./parsers.js`," and Task 6's new `range.test.ts`
opens with `import { parseAgency } from "./parsers.js";`. `parsers.ts` does not
export `parseAgency` — `lib/parser.ts` does. The new test file will not compile.

`lib/parsers/function.test.ts:11` already has the correct import
(`import { normalizeCode, parseAgency } from "@/parser.js";`), so the convention
exists; the plan just points at the wrong file.

Also worth matching: existing callers pass three arguments,
`parseAgency(input, {}, false)`. The third is `applyTemplate`, which defaults to
`true` and renders the whole standard-library prelude into the source before
parsing. The plan always calls the one-argument form. AST-equality tests still work
that way (both sides get the prelude), but every parse carries the prelude for no
reason, and it matters a great deal for the formatter assertions below.

### The formatter assertions use the wrong API

Every "normalizes X when formatted" test is built on:

```ts
const formatted = new AgencyGenerator().generate(parseAgency(src));
expect(formatted).toContain("def add(");
```

Three problems in two lines. `generate` takes an `AgencyProgram`
(`agencyGenerator.ts:211`), not the `ParseAgencyResult` the plan hands it. It
returns `{ output: string }`, not a string, so `toContain` is inspecting an object.
And with `applyTemplate` defaulting to `true`, the program being formatted contains
the entire prelude.

The repo already has the right tool: `formatSource(source)` in `lib/formatter.ts:9`
returns `string | null` and, per the first test in `lib/formatter.test.ts`, "does
not inject stdlib imports when formatting user source." Every normalization
assertion in this plan should call it:

```ts
expect(formatSource(`function add(a: number, b: number): number { return a + b }`))
  .toContain("def add(");
```

### Tests that pass without proving the thing they name

Beyond the vacuous `not.toThrow` cases, two tests would still be weak after the
assertion style is fixed.

**The match-guard adjacency test.** `_ if (a >-3) -> "yes"` is checked only for
parsing at all. The risk it exists to cover is *mis*-parsing — `a > -3` read as
something else — which a success check cannot see. It should assert AST equality
against the `=>` spelling, like every other test in Task 4.

**The `.` / `..` / `...` distinctness test.** Same shape. Confirming that
`[...a, 3]` parses does not confirm it parsed as a spread. Compare against a
known-good AST instead.

### Missing cases

Ordered by how much they matter.

- **`["a..b"]` — a string literal containing two dots.** This is the input that
  exposes finding 2 above. With no test for it, the bug ships. Add it to Task 7
  alongside the cases that must keep working.
- **The `RESERVED_WORDS` change is entirely untested.** Task 2 Step 4 adds
  `"function"`, whose only consumer is `fill()` at `lib/runtime/template/fill.ts:375`.
  Delete Step 4 and every test in the plan still passes. A test that
  `fill(t, { name: "function" })` is rejected would cover it.
- **Is `const function = 5` still legal?** The changelog entry in Task 10 says
  "Breaking — `function` is now a reserved word. It was previously usable as a
  variable name." But Task 2 Step 4 says the list "does not govern general
  identifier parsing." Those cannot both be true, nothing tests it, and it parses
  today. Decide, then pin it.
- **Formatter idempotence is gone.** The spec asked for it explicitly: "Formatting
  an already-formatted file that originally used the variations changes nothing on
  the second pass." No task carries it. Task 10's fixture check is a different
  thing — it verifies canonical source is unchanged, not that a normalized file is
  a fixed point. `formatSource(formatSource(src)) === formatSource(src)` for each
  of the four variations.
- **`rest` correctness in the ordinary case.** Task 5's prose flags the fragile
  coupling between `prefix.length` and `input`, but the underscore test asserts
  only `value`. That is exactly where an off-by-one from the coupling would appear.
  Add `expect(numberParser("1_000 + 2").rest).toBe(" + 2")`.
- **`x..y == z` precedence.** Task 6 states the grouping rule for both directions
  but only tests the additive one (`a + 1..b - 1`). The relational half is
  unasserted.
- **A match arm whose body is an inline block**, `match (x) { 1 -> \n -> n * 2 }`.
  This is the interaction between the two edits Task 4 makes, and it is the one
  shape where the two arrow changes meet. Untested.
- **Negative and degenerate ranges.** `-3..6` (negative left operand), `5..5`
  (empty), `6..3` (inverted). None appear, and the last has no defined behavior
  anywhere in the plan or spec.
- **Comprehensions.** `[x * 2 for x in xs]` shares the `[` opener with the new
  bracketed-range probe and is the most likely thing to break. It is covered only
  by a regression suite run, with no assertion of its own.
- **Unit literals.** Task 5 Step 5 mentions `1.5s` as a debugging hint but no test
  asserts it, even though `unitLiteralParser` sits directly in front of
  `numberParser`.

### What the tests get right

Task 8's execution test is the best-designed test in the plan. Returning
`[count, total]` rather than either alone means a collapsed range shows up as
`count === 1` and an off-by-one at either end shows up in `total` — 12 against 15
for an inclusive end. One assertion catches both failure modes.

Task 5's unit tests are at the right altitude too: they call `numberParser`
directly rather than going through whole programs, so a failure points at the
parser instead of at whatever downstream construct happened to notice.

And the core idea — assert the variation produces the same AST as the canonical
spelling, then assert the formatter emits the canonical spelling — is exactly the
right pair of tests. The problems above are in how the assertions are written, not
in what the plan chose to check.

---

## What I verified

| Plan claim | Location | Verdict |
|---|---|---|
| `bodyDeclarationParser` probes `node`/`def` | `parsers.ts:4584` | correct |
| keyword capture is `str("def")` | `:5730` | correct |
| keyword discarded | `:5848` | correct |
| `oneOfStr` already defined | `:286` (plan says 284) | correct, off by two |
| `RESERVED_WORDS` | `:215` | correct |
| return-type parser uses `char(":")` | `:5703` | correct |
| `def` and `node` both delegate | `:5757`, `:5918` | correct |
| match arms use `str("=>")` | `:3968` | correct |
| inline blocks use `str("->")` | `:3795` | correct |
| block types accept both arrows | `:1765` | correct |
| `numberParser` body | `:597-612` | correct |
| `makeBinOp` | `:3364` | correct |
| operator table, `apply` hooks | `:3437+` | correct |
| generator emits `def` / `:` | `agencyGenerator.ts:1176`, `:1129` | correct |
| all named test files exist | `lib/parsers/*.test.ts` | correct (12 of 12) |
| `.test.json` format | `tests/agency/agency-review.test.json` | correct |
| `FunctionCall` shape matches the builder | `lib/types/function.ts:80` | correct |
| "literal alternatives list" | `:2274` | **wrong parser** |
| `pnpm test:run tests/formatter` | — | **runs nothing, exits 1** |
| `pnpm run docs:build` | — | **does not exist** |
| "no `stripLocs` helper already" | `lib/parsers/vitest.setup.ts` | **wrong — `toEqualWithoutLoc` is global, used in 23 files** |
| `parseAgency` throws on parse failure | `lib/parser.ts:273` | **wrong — returns `{success:false}`; verified on 5 inputs** |
| `parseAgency` comes from `./parsers.js` | `lib/parser.ts` | **wrong module — it is `@/parser.js`** |
| `generate()` returns a string | `agencyGenerator.ts:211` | **wrong — returns `{ output: string }`, and takes `AgencyProgram`** |

I also confirmed `numericPrefix` in Task 5 behaves as claimed by tracing it:
`"3..6"` returns `"3"` (the second dot has no digit after it), `"1.2.3"` returns
`"1.2"` (`seenDot` already set), `"3.5"` and `"1_000"` are untouched. The
underscore-strip relocation the plan flags is genuinely necessary — without it
`prefix.length` would no longer index into `input`, and `rest` would be wrong.

**Limitations.** Nothing here is implemented, so every claim about runtime
behavior is reasoning over source, not measurement — including the
`["a..b"]` rejection in finding 2 and the stale-`dist` failure in finding 4. The
three findings I did execute are 3 (ran the command), and the file and line
checks. I did not evaluate whether `buildExpressionParser` can expose a
single precedence level, which Option A in finding 2 depends on.

---

## Recommendation

Fix findings 1, 3, and 4 before starting — they are small edits to the plan and
each one otherwise costs a confusing debugging session. Finding 2 needs a decision
before Task 7 is written, not during it.

From the anti-pattern audit, two more edits belong in that same pass, because both
change code the plan asks the implementer to type verbatim:

- **Swap `stripLocs` for `toEqualWithoutLoc`** everywhere it appears. Purely
  mechanical, and it removes a helper that is weaker than the one the repo already
  has.
- **Rewrite Task 5's `numberParser`** as a combinator grammar rather than a greedy
  match plus a truncating scan. This is the one change that is more than mechanical,
  but it is confined to a single step and it removes the manual `rest` arithmetic
  and the index coupling along with the imperative loop.

From the test-plan audit, three corrections have to be made to **every** task
before any of them is executed, because they affect assertions the implementer
would otherwise type out verbatim and then debug:

- **Assert on the returned result, not on throwing.**
  `expect(parsed.success).toBe(false)` and `expect(parsed.message).toMatch(...)`,
  never `expect(() => parseAgency(src)).toThrow(...)`. Delete the three
  `not.toThrow` assertions outright and replace them with AST comparisons.
- **Import `parseAgency` from `@/parser.js`**, not `./parsers.js`.
- **Use `formatSource(src)` from `lib/formatter.ts`** for every normalization
  assertion, instead of `new AgencyGenerator().generate(parseAgency(src))`.

With those three plus the `stripLocs` swap, the test bodies throughout the plan
become correct. The missing cases listed in that section can be added task by task
as each is implemented.

Tasks 1 through 4 and 6 are otherwise ready to execute, with the two small
corrections noted earlier (`oneOfStr` is at `:286`, and give `makeRangeCall` a
`loc`).
