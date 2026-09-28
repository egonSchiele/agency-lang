# Review: code literal parse and print fixes — implementation plan

Reviewed plan: `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-28-code-literal-parse-and-print-fixes.md`

I checked the plan's parser mechanics against tarsec 0.5.3 (the version in
`package.json`) and against the code it modifies. One finding is blocking:
Task 2's parser, exactly as written, does not change any behavior, because of
how tarsec's `or` treats an ordinary failure. Everything else is either a
consequence of that finding or minor.

## Verdict

Tasks 0, 1, 3, 4, and 5 are sound and executable as written. Task 2's
mechanism is wrong: it needs `committedFailure`, not `failure`, and that
correction changes the expected behavior of `bodyParser` enough that Task 2's
body-level tests must be rewritten too. The plan's two test sections currently
expect two different semantics, so no single implementation can satisfy both.
The fix is small and stays entirely inside the plan's architecture.

---

## Finding 1 (blocking): an ordinary `failure` does not stop `or` from trying the next alternative

Task 2 Step 3 has `bodyDeclarationParser` return
`failure(BODY_DECLARATION_MESSAGE, probed.rest)` and forbids `parseError`
because it throws. The forbidding is right; the replacement is wrong. In
tarsec, `or` treats a plain failure as "this alternative declined, try the
next one" (`node_modules/tarsec/dist/combinators.js:178-190`: on a
non-committed failure the loop simply continues). `bodyDeclarationParser` sits
in the middle of `_bodyNodeParser`'s `or(...)` list, and the alternatives
after it include `binOpParser` and `valueAccessParser` — the very parsers that
read `node` as a variable name today. So the decline is a no-op: `or` falls
through, `node` parses as a name exactly as before, and the mis-parse
survives. The plan's own Step 4 ("Expected: PASS, all of them") is
unachievable with the code in Step 3.

Tarsec has the exact tool for this, and this file already imports it:
`committedFailure(message, rest)` (`lib/parsers/parsers.ts:62`;
`tarsec/dist/types.js:35-37`). A committed failure is a failure that stops
backtracking: `or` returns it instead of trying later alternatives
(`combinators.js:185-187`), and it does not throw, so it cannot reproduce the
`static const` bug that Task 3 fixes. It is also the codebase's established
pattern — the nested-literal directive at `parsers.ts:3041` uses
`committedFailure` for precisely this "decline and do not let anyone else
reinterpret it" job.

**Correction:** the last line of the parser becomes
`return committedFailure(BODY_DECLARATION_MESSAGE, probed.rest) as ParserResult<never>;`
and the Global Constraints bullet should say: never `parseError` (it throws),
and never plain `failure` (later alternatives reinterpret the keyword as a
name) — `committedFailure` is the only mechanism that does this job.

## Finding 2 (required, follows from Finding 1): Task 2's body-level tests assume semantics the fix cannot produce

With `committedFailure`, `many` fails the whole repetition when it hits one
(`combinators.js:40-42`). That changes what `bodyParser` returns, and Task 2
Step 1's tests are written for a different, gentler behavior:

- `bodyParser("node inner() { print(1) }")` will return a *failure* whose
  message is `BODY_DECLARATION_MESSAGE` — not a success with zero statements
  consumed. The test's `result.result.map(...)` reads a field that does not
  exist on a failure.
- `bodyParser("print(1)\nnode inner() { print(2) }")` will also return that
  failure — not a partial success holding one `functionCall` with the
  declaration left in `rest`.

Note the internal inconsistency this exposes: Step 1 expects the statements
parse of "statement then declaration" to *partially succeed*, while Step 5's
literal table expects that same body to infer kind `program` — which only
happens if the statements attempt *fails outright* so kind inference falls
through. Under plain `failure` neither works; under `committedFailure` Step 5
is right and Step 1 is wrong. Rewrite the three declining tests to assert:
`result.success` is `false` and `result.message` is
`BODY_DECLARATION_MESSAGE`. The keyword-as-variable guard tests in Step 1 are
correct as written and should stay.

Step 5's literal table is consistent with committed semantics throughout,
including "statement then declaration" (bare calls are legal at file top
level, so the program attempt accepts that body). No changes needed there.

## Finding 3 (recommended): the probe is broader than the declaration shape, and commitment raises the stakes

The probe declines on keyword + whitespace + one identifier character. With
commitment, a decline is now a hard parse error for the whole body, so the
probe's precision matters more than it did in the spec's routing design.
Statements it would newly reject that are legal today:

- Word-operator expressions in statement position: `node is string`,
  `node as Foo`, `node in items` as a bare expression statement. Each is
  keyword, space, identifier — declined, hard error.
- If tarsec's `space` matches newlines, also `node` on one line and `main()`
  on the next (a real variable and a real call). The spec review accepted
  this shape as a residual, but as a *kind flip*, not a hard error. Verify
  what `space` matches during implementation.

The actual declaration grammar requires more: keyword, name, then `(`. Extend
the probe to consume the identifier and require `(` (with whatever spacing the
real `node`/`def` parsers accept between name and paren — mirror them, don't
guess). That keeps every word-operator statement out of the decline, and it
moves the failure position past the declaration name, which directly helps the
plan's own soft spot (Task 2 Step 7's worry that rightmost-failure reporting
might prefer a different alternative's message). The plan already gestures at
this extension as the Step 7 contingency; given Finding 1 it should be the
primary design, not the fallback.

## Finding 4 (watch during execution): a committed failure travels further than a thrown one used to

`bodyParser` parses every block in the language — function bodies, `if`
bodies, trailing-block calls. A committed failure propagates out through `or`
and `many` by design, so any place the grammar speculatively tries a
block-shaped parse and relies on ordinary failure to back out and take a
different reading will now surface `BODY_DECLARATION_MESSAGE` instead. I could
not find a concrete breaking case, and Task 2 Step 8 (the full `lib/parsers/`
suite) is the right backstop — but the plan should tell the executor how to
read a failure there: a pre-existing test failing with the new message means
the committed decline escaped a context that used to backtrack, and the
repair is narrowing the probe (Finding 3), not weakening the commitment.

## Finding 5 (minor)

- **Task 1, frozen-input test:** the plan assumes the `program.nodes`
  write-back is the printer's only mutation of its input. If the deep-frozen
  test still throws after Step 3, that assumption failed — some pass mutates
  deeper — and the plan gives no instruction. Add one line: treat any
  remaining throw as a second mutation site to fix the same way (local copy,
  never write-back), not as a reason to clone the input.
- **Task 1, parse helper:** the plan calls `parseAgency(text, {}, false, false)`
  (fourth argument `lower: false`). The existing tests in the same file call
  `parseAgency(input, {}, false)`, letting `lower` default to `true`
  (`lib/parser.ts:273-278`). Match the file's convention unless there is a
  reason to print an unlowered tree, and if there is, say it in the plan.
- **Commit trailers** name "Claude Opus 5 (1M context)". The current session
  convention is `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
  Cosmetic, but the executor will copy it verbatim.

## Claims I verified as correct

- The Task 1 pass-ordering instruction is right and fixes the spec's error:
  passes 1 and 2 read `program.nodes` before the partition
  (`lib/backends/agencyGenerator.ts:203,210`), and passes 3, 4, and 5 all run
  after it (lines 227, 234, 252-268). Pass 5's loop over `program.nodes` at
  line 254 is exactly the third loop the plan says to repoint.
- `TarsecError` is imported at `lib/parsers/parsers.ts:8`, as Task 3 claims,
  and tarsec's `parseError` throws it (`tarsec/dist/combinators.js:977-988`).
- Every helper and file the tests lean on exists: `firstLiteral` in
  `lib/parsers/codeLiteral.test.ts:14`, `parseTemplateMode` in
  `lib/backends/agencyGenerator.roundtrip.test.ts:27`, `deepFreeze` exported
  from `lib/runtime/utils.ts:12`, and `lib/parsers/body.test.ts` is a real
  file.
- The Task 4 fixture's shape — `isFailure` checks, `handle { ... } with (e)`
  approving the `std::run` effect, the `.test.json` schema with
  `expectedOutput`/`evaluationCriteria` — matches the existing
  `tests/agency/templates/generatedProgram.agency` fixture almost line for
  line, including correctly omitting the `interruptHandlers` entry that
  fixture only needs for its `loadTemplate` read.
- Task 3's second test expects `static const x = 2` to come back as node type
  `assignment`: correct — the top-level parser builds an assignment and sets
  `static: true` on it (`lib/parsers/parsers.ts:4435-4437`).
- `nodeCount()` staying untouched: the probe requires whitespace after the
  keyword, and `str("node")` followed by `Count` fails `many1(space)`. The
  guard test is still worth keeping.
- tarsec is at 0.5.3 as stated.

One thing I did not verify: whether tarsec's `space` matches newline
(Finding 3's second bullet). Check it before choosing the probe shape.

---

## Anti-pattern audit (against `docs/dev/anti-patterns.md`)

Requested separately: does the plan's code violate the catalog, and in
particular does it expose declarative interfaces that encapsulate the
imperative work?

### Two real hits

**`tryAttempt` is the try-catch-without-logging anti-pattern, and its `null`
return leaks the reason for it into every call site.** The Task 3 helper
catches a `TarsecError` and returns `null` — nothing is logged and the
error's message is discarded. The swallow is deliberate ("a throw is a
non-match"), which is more defensible than the catalog's bad example, but the
diagnostic text still vanishes: if every attempt fails, the thrown attempt's
message is gone and cannot inform the final error. And the `null` forces each
call site into a three-state check (`asExpr !== null && asExpr.success &&
...`), which is the internal detail — "this attempt died rather than failed"
— leaking through the interface. Both problems disappear with one change:
have `tryAttempt` return `ParserResult<T>` always, converting a caught
`TarsecError` into an ordinary `failure(error.message, "")`. Then a caught
throw *is* a failure, the call sites keep their existing two-state
`.success` checks completely unchanged, and the message survives for
whoever wants it. That is a smaller diff than the plan's version — the
attempt lines change but the `if` conditions do not.

**The probe duplicates the declaration grammar instead of reusing it.** The
shape check `or(str("node"), str("def")), many1(space), or(letter, char("_"))`
restates, approximately and incompletely, the prefix that the real `node` and
`def` declaration parsers already define. That is the "duplicating existing
code" entry: two statements of one grammar fact, which can drift — if the
declaration syntax ever changes, the probe silently stops matching it. The
fix folds into Finding 3, which wants the probe extended through the name to
the `(` anyway: build the probe from the same combinator pieces the real
declaration parsers use (or extract the shared prefix into one definition
both consume), rather than hand-rolling an approximation.

### Where the plan is on the right side of the catalog

The "imperative code everywhere" question is worth answering directly,
because the plan's central design choice is the *good* version of that rule.
The spec's first draft fixed this bug imperatively: peek at the literal body,
match keywords, route between parsers — "how" logic living in
`parseCodeLiteralBody`. The plan instead states one grammar fact
declaratively — a declaration shape is not a body statement — as an
alternative in `_bodyNodeParser`, and the literal behavior falls out of kind
inference with no routing code at all. That is exactly "change the what, not
the how", and it is the plan's strongest property. Likewise
`bodyDeclarationParser` itself follows the established
`bodyReservedModifierParser` probe-and-report pattern (consistency), the
Task 1 fix replaces a mutation with a `const` derived from its input
(order-dependent-mutable-state, good form), and the tests are declarative
case tables driving `it()` blocks rather than repeated imperative bodies.

Checked and clean: no nested ternaries, no one-line `if`s, no magic numbers,
no dynamic requires, no nested type definitions, no file deletion in code
(the `investigate/` cleanup is a manual pre-PR step), and no test whose
failure is destructive. Single-character `e` in the fixture's `with (e)`
handler matches the existing fixture convention, where consistency wins.

---

## Test plan audit

Requested separately: does each test actually test what it is meant to, will
it fail when the code breaks, and what is missing. Verdict per test, then the
gaps. (This audit assumes the Finding 1/2 corrections — `committedFailure`
and rewritten body-level assertions — are applied first; the original Task 2
Step 1 tests cannot pass at all.)

### Tests that do their job

- **Task 1, frozen-input test.** The direct expression of the bug: reverting
  the fix reintroduces the write to a frozen object, which throws, which
  fails the test. Solid.
- **Task 1, no-mutation test — fails pre-fix, but see the gap below.** I
  checked `partitionImports` (`agencyGenerator.ts:329-360`): it extracts
  imports out of the returned stream, so for the test's source the type
  sequence genuinely loses its `importStatement` and the before/after
  comparison fails before the fix, as Step 2 predicts.
- **Task 2, literal kind table.** Asserting kind `program` *and* the first
  node's type *and* the absence of `variableName` is exactly right — kind
  alone was already wrong for a reason only the node type reveals, and the
  plan says so. Reverting `bodyDeclarationParser` flips these back to
  `statements` and they fail.
- **Task 2, keyword-as-variable guards** (`node.run()`, `node + 1`,
  `node(1)`, bare `node`, `debugger`, `nodeCount()`). These pin the narrow
  shape of the probe; widening it fails them. Right set, right assertions.
- **Task 3, both static-const tests.** Removing the throw containment makes
  the `parseError` throw escape again, which fails the tests loudly. And
  Step 5's regression filters are real: "unclosed literal reports the
  missing |]" and "nested [| is a directive error" exist at
  `codeLiteral.test.ts:210,221`, so the `-t` filters match actual tests
  rather than silently running nothing.
- **Task 4, formatter golden and both execution fixtures.** The golden is
  byte-exact, so the reported symptom (the split `node` / `main() {`) cannot
  return unnoticed. Fixture 1 fails if any stage of
  parse→fill→print→re-parse→compile→run regresses; fixture 2 throws if the
  printer mutation returns. The `"hello " + who` concatenation I doubted is
  fine — existing fixtures use `+` on strings
  (`generatedProgramTemplate.agency:3`).

### Tests that do not test what they claim

**Task 1's third test ("still sorts and hoists imports") is vacuous for its
stated purpose.** Its two `toContain` assertions are position-blind, and its
source puts the import on line 1 — already at the top. Delete `partitionImports`
from the fix entirely and this test stays green: both strings are still in
the output. The stated purpose is "the guard that the fix does not disable
partitioning", and it guards no such thing. Fix: use a source whose import
sits *below* the node declaration, and assert order —
`printed.indexOf("import ...") < printed.indexOf("node main")`. That fails
the moment partitioning stops happening. (The Step 5 corpus round-trip would
also catch it, but the unit test should not pretend to cover what it
doesn't.)

**Task 1's no-mutation test compares too shallowly to be a general
invariant.** Mapping `node.type` detects the known mutation (the write-back
changes the type sequence for this source) but misses any *deeper* mutation:
a pass that rewrites a field inside a node, or a reorder among nodes of the
same type, leaves the type list identical. The test's name promises "leaves
the caller's node list untouched"; make it true by snapshotting
`JSON.stringify(program)` before the call and comparing after. Costs one
line, upgrades the test from "detects this bug" to "detects the class".

### Missing test cases

1. **The ordinary-body error message has no automated test.** Task 2 Step 7
   checks the compile error for `node inner()` inside a real body by eye,
   once. Nothing prevents a later parser change from silently degrading that
   message back to a generic failure. Add a unit test: `parseAgency` on that
   source fails with a message containing `BODY_DECLARATION_MESSAGE`. Step 7
   then confirms presentation (file/line/column); the test pins the
   substance.
2. **Word-operator statements** (Finding 3): whatever probe shape is chosen,
   pin `node is string` (and one `in`-flavored case) with the decided
   behavior. Under the plan's broad probe plus `committedFailure` these flip
   from legal to hard error, and no test would notice.
3. **A committed decline inside a nested block.** All the declining tests hit
   the top level of a body. Add one where the declaration sits inside an
   `if`: `if (x) { node inner() { } }` — asserting the parse fails with
   `BODY_DECLARATION_MESSAGE`, not a generic block error. This is the
   propagation path Finding 4 worries about, exercised in its simplest form.
4. **The broken-declaration case from the spec is dropped.** The spec's test
   list had `node main( {` inside a literal reporting a parse error instead
   of silently succeeding as statements. The plan carries no version of it.
   With the committed decline it should fail the statements attempt and
   surface the program attempt's error — assert that the parse fails and the
   error is about the declaration, not about two statements.
5. **`def` is undertested relative to `node`.** The literal table has an
   un-annotated `def` but the annotated-still-works check covers only
   `node main(): string`; add `def foo(): number`. Cheap, and `def` takes the
   other branch of the probe's `or`.
6. **Nothing pins that a non-`TarsecError` throw still propagates** out of
   `tryAttempt`. With the module-local helper this is awkward to reach from
   a public surface, and I would accept the gap — but it belongs in the
   plan's known-soft-spots list rather than going unmentioned, because the
   `instanceof` filter is the only thing separating "recovered attempt" from
   "swallowed compiler bug".

One process note: the plan's run-to-fail steps only protect against vacuous
tests if the executor treats "expected FAIL, observed PASS" as a stop
condition. Worth one sentence in the plan's global constraints, since two of
the findings above are exactly tests that would pass without the fix.
