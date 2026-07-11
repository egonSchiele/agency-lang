# Review: Schema Chaining plan (issue #480)

**Plan:** `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-11-schema-chaining.md`
**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-11-schema-chaining-design.md`
**Reviewed:** 2026-07-11, against main (every claim below re-verified in code, not taken from the plan)

## Verdict

Strong plan. The `peek(".")` + `parseError` refinement over the spec's plain
`many1` is a genuine improvement and follows an exact in-repo precedent.
Approve after the three "should fix" items below — all are small test/gate
adjustments, none change the architecture.

## Verified facts — all check out

I independently confirmed every entry in the plan's "Verified facts" section:

- `peek`, `parseError`, and `captureCaptures` are all already imported in
  `lib/parsers/parsers.ts` (import lines 13, 38, 39).
- `parseAgency` catches `TarsecError` and converts it to a parse failure
  carrying the message (`lib/parser.ts:313` region).
- `angleBracketsArrayTypeParser` (parsers.ts:1107) is an exact precedent for
  the proposed composition — `memo(seqC(..., captureCaptures(parseError(msg,
  capture(...)))))` — so the snippet's combinator usage is proven shape, not
  invention.
- Definition-order/TDZ claim is right: `schemaExpressionParser` (2643) →
  new parser → `baseAtom` (2656) works as a plain value reference; the
  call-time reference from `_valueAccessParser` (2483, defined earlier) is
  safe.
- All four claimed test homes exist: `lib/parsers/expression.test.ts` (schema
  parse tests start at line 380, matching the plan's ~384),
  `lib/typeChecker/schemaType.test.ts`, `lib/backends/agencyGenerator.test.ts`,
  and `tests/agency/schema-param-injection.js`.
- Task 4's `isSuccess(r)` idiom is valid Agency AND typechecks: the checker
  narrows on `isSuccess`/`isFailure` calls (`lib/typeChecker/narrowing.ts:227-237`),
  so the `r.value` access inside the guard passes strict member access. Both
  `isSuccess(r)` and `r is success(v)` appear in existing `tests/agency/` files.
- Statement-position repro (functionCall named `schema` today) was verified
  during the spec review by dumping the AST.

## Should fix before execution

### 1. `peek(char("."))` misses `?.` — gate on `dotParser` instead

`dotParser` (parsers.ts:2355) accepts both `?.` and `.`, and every dot-led
chain element goes through it. With the plan's `peek(char("."))`,
`schema(number)?.parseJSON(x)` fails the peek, falls through to the bare
schema atom, and dies with the old stranded-suffix failure — an inconsistency
the spec's plain `many1` would not have had. The parser comment carves out
non-dot heads (`[i]`, `(args)`) but is silent on `?.`, which is dot-led in
every sense that matters.

Fix: `peek(dotParser)` (already defined right above the chain parsers), so the
commit gate matches exactly the set of inputs `dotMethodCallParser` accepts.
If instead `?.` is deliberately excluded, say so explicitly in the comment and
non-goals — silence reads as an oversight.

### 2. Missing statement-position bare-schema pin (spec test row 1)

The spec requires bare `schema(number)` pinned unchanged in **both**
positions. Task 1 pins expression position; Task 2 only asserts the
statement-position legacy shape in prose ("bare `schema(T)` statements still
take the legacy functionCall path" — Step 4 Expected) with no test. This is
precisely the behavior the peek gate exists to preserve, so pin it: one Task 2
row asserting a bare statement-position `schema(number)` still parses as a
`functionCall` named `schema`.

### 3. Missing assignment-target pin (carried over from the spec review)

Inserting `schemaAccessParser` into `_valueAccessParser` also changes what the
assignment-target parser (parsers.ts:3590, `capture(_valueAccessParser,
"target")`) sees: `schema(number).foo = 5` flips its target from
functionCall-base to schemaExpression-base. Benign (semantic error either
way), but the spec review asked for it to be named and cheaply pinned, and the
plan doesn't carry it. Add one row to Task 2: the statement parses as an
assignment whose target is a `valueAccess` with a `schemaExpression` base (or,
equivalently, a checker pin that it errors cleanly).

## Minor notes — no block, executor discretion

- **Whitespace-before-dot loses nothing:** chain elements never allow leading
  whitespace anywhere in the language (`dotParser` starts at the dot;
  `_valueAccessParser` and `parenAccessParser` attach chains with no space
  skip), so the peek gate does not newly break multiline fluent chains — they
  were never supported for any base. Worth one line in the parser doc comment
  so a future reader doesn't attribute this to the peek.
- **Hard-commit safety:** I probed for a valid program containing `schema(T).`
  where `many1(chainElementParser)` fails and found none — `schema` is in
  `RESERVED_FUNCTION_NAMES`, and a postfix dot demands a chain element in
  every expression context (including interpolations), so `parseError` can
  only fire on genuinely invalid input. The comment could state this in one
  sentence; it is the whole justification for the throw.
- **Task 1 helper fields are also guesses:** the NOTE flags the chain-element
  shapes and the failure-message field, but `parsed.result.nodes`,
  `node.body`, and `type === "assignment"` for a `const` statement are equally
  unverified. Extend the NOTE's verify-with-`pnpm run ast` instruction to the
  whole helper skeleton.
- **Lighter test harness available:** the existing schema tests at
  `expression.test.ts:380` call `exprParser` directly on the bare expression
  string. The expression-position rows could use that pattern and skip the
  `parseAgency` + node-digging helper entirely; only the statement-position
  and error-message rows need full-program parsing.
- **Task 3 exactly-one-error assertion** may be brittle if `check()` surfaces
  unrelated diagnostics on that snippet; fine as a pin, executor adjusts on
  first run.
- **Worktree setup:** add `git fetch origin` before `git worktree add ...
  origin/main` so the branch bases on current main, not a stale ref.

## Altitude check

Right level. The plan reuses the two pieces of machinery the codebase already
owns for exactly these semantics — the `parenAccessParser` chain-base idiom
and the `angleBracketsArrayTypeParser` commit-then-`parseError` idiom — rather
than inventing anything. The peek-commit is a real refinement over the spec
(targeted error once user intent is unambiguous, zero behavior change for
bare `schema(T)`), and the plan correctly records it as a plan-level deviation
to surface in the PR body. Task sequencing (expression → statement → pins →
fixtures → full verify) is red-first throughout, and Task 3's STOP-on-failure
correctly treats a downstream failure as a spec falsification rather than
something to patch silently.
