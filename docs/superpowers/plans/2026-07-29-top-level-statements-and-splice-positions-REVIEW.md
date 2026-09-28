# Review: top-level statements and splice positions — implementation plan

Reviewed plan: `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-29-top-level-statements-and-splice-positions.md`

I verified the plan's anchors against the code and — most importantly —
checked the predicate table against the real `AgencyNode` union, since the
table is the whole feature. The plan absorbed every spec-review finding (the
measured `handle` crash row, the program-fragment smuggling hole, the
message ternaries, the interrupt measurement — now measured: compiles, then
`__self is not defined` at run time). The structure is right. Four findings
need fixing before execution; the first is the significant one.

## Finding 1 (blocking): the predicate table does not match the real union, and the mismatch is not just names

The plan anticipates spelling drift ("if a type name does not match, fix
it") — but the gap is bigger than spelling, because several missing keys
need *decisions*, and two of them contradict the plan's own tests as
written.

The `Literal` member of `AgencyNode` (`lib/types/literals.ts:4-11`) is
itself a union contributing the type strings `"number"`, `"unitLiteral"`,
`"string"`, `"multiLineString"`, `"variableName"`, `"boolean"`, and
`"null"`. Consequences for the table in Task 1 Step 3:

- **`literal: false` is not a key** — no node has type `"literal"`. The
  seven strings above are the keys, and each needs a value.
- **`variableName` must be `true`.** Bare `debugger` parses as a
  `variableName` (established during the code-literal work: `debuggerParser`
  requires parens, so the bare word is a name). With the key absent, the
  lookup returns `undefined`, `isLegalAtTopLevel` is falsy, and the plan's
  own allowed-list test for `debugger` fails. Same for any bare name at
  file scope, which compiles today.
- **`boolean` must be `true`** — the measured table says bare `true`
  compiles, and it is in the allowed test list.
- **`number`, `string`, `null`, `unitLiteral`, `multiLineString` need
  measuring, not guessing.** The plan measured `"hello"` as a parse error
  and `true` as compiling — so the top-level grammar treats literal forms
  unevenly, and bare `42` and bare `null` are unmeasured. The global
  constraint ("do not widen the refusal") makes the policy mechanical:
  anything the grammar accepts and that compiles today is `true`; anything
  the grammar cannot produce at top level is unobservable and `false` is
  fine. But the measurements have to exist first.
- **`regexLiteral` should be `regex`** (`lib/types/literals.ts:95`).
- **`debuggerStatement` is a real type** (`lib/types/debuggerStatement.ts`)
  but it is the parenthesized `debugger(...)` form, not the bare word — its
  top-level behavior is also unmeasured.

The exhaustiveness mechanism will surface all of this as compile errors at
Task 1 Step 5, so nothing ships wrong — but the executor will be making
allowed/refused decisions the plan meant to make itself. Fix the table in
the plan: correct the two known-wrong keys, add the seven literal-union
keys with `variableName`/`boolean` as `true`, and add a measurement step
for the four unmeasured forms with the no-widening policy stated as the
tiebreaker.

## Finding 2 (concrete test bug): `firstNode` skips the node one test needs

The helper's skip list includes `importStatement`, and the allowed list
includes `'import { read } from "std::fs"'` as a test case — for that
source, the helper skips the only node and throws `no node in: …`. Remove
`importStatement` from the skip filter (skip only trivia); the import case
then works and nothing else changes.

## Finding 3 (self-contradiction): Task 4 Step 3 says drop it, then says keep it

The step reads "…and drop `\"statements\"` from `KINDS_FOR_POSITION.decl`,
which the per-node check now supersedes:" — followed by the unchanged line
and "stays as it is — the kind gate still admits both shapes; the per-node
check is what decides." An executor can read this either way, and the two
readings behave differently (dropping it would refuse every statements
generator at top level regardless of content). The second reading is the
correct one; delete the "drop" sentence and state it once: the kind entry
stays, the per-node predicate check is added after the kind gate.

## Finding 4 (verify before relying on it): two diagnostics sharing the code `AG3017`

The plan gives `topLevelStatementNotAllowed` and `topLevelHandlerNotAllowed`
the same code. I checked: no two entries in `lib/typeChecker/diagnostics.ts`
share a code today, so this would be the first, and anything that looks up
by code — `agency explain AG3017`, the explanations file if it is keyed by
code — has never had to handle a collision. Either give the handler wording
its own code (`AG3018` is free; `AG3016` is the current highest in that
range, `diagnostics.ts:439`) or verify the by-code paths handle duplicates.
The distinct code is also better for users: "handler at top level" is a
different mistake from "if at top level" and deserves its own explain page.

## Smaller points

- **`static interrupt("x")`'s message reads as `staticStatement`.** The
  pass reports `describeKind(node.type)` on the wrapper, so the user is
  told a "`staticStatement`" is not allowed. Unwrap in the pass: when the
  node is a `staticStatement`, describe the inner statement. The predicate
  already defers to the inner node; the message should too.
- **The builder pre-pass should mirror the existing throw shape.** The
  anchor is real — `build()` opens with the unfilled-holes refusal
  (`typescriptBuilder.ts:502-512`) — but that code renders through
  `renderMessage(DIAGNOSTICS….message, {…})` and the plan's snippet
  hand-concatenates a message instead. Use the same rendering path;
  consistency is the point of anchoring there.
- **Task 5's "copy from a neighbouring fixture" hedge points at a neighbor
  that does not exist.** There are no splice execution fixtures under
  `tests/agency/` today (checked); the working splice examples live in
  `lib/preprocessors/expandSplices.test.ts` and the splices design doc.
  Point the hedge there.
- Commit trailers again name "Claude Opus 5 (1M context)"; the session
  convention is `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Claims verified as correct

- `AG3016` is the current highest in the structural range, so `AG3017` is
  free (`diagnostics.ts:439`).
- The type-checker wiring anchor is exact: `checkTemplateHoles` is called
  at `lib/typeChecker/index.ts:369`, imported at line 49.
- The builder anchor is exact: `build()` begins with the unfilled-holes
  refusal at `typescriptBuilder.ts:502-512` (the plan calls it "the AG8001
  refusal"; the literal string lives in `DIAGNOSTICS.unfilledHoles`, which
  is why a grep for AG8001 in the builder finds nothing — worth a
  parenthetical so the executor is not confused the same way I briefly
  was).
- The measured table's new rows check out against earlier findings: the
  block-form `handle` crash matches what I reproduced during the spec
  review, and `handleBlockParser` genuinely is in the top-level alternation
  (`lib/parser.ts:90`), which the background now states correctly.
- `StaticStatement` has the `{ statement }` shape the wrapper logic
  assumes (`parsers.ts:4560-4563`), and `static const` parses as an
  `assignment` with a static flag rather than a `staticStatement`, so the
  allowed list routing (`static const` via `assignment: true`) is right.
- The interrupt rows are now measured (`__self is not defined` at run
  time), the refusal is correctly framed as a better error rather than a
  fix, and Task 5 Step 3 files the underlying bug — which resolves the
  spec review's Finding 4 the right way.
- Union checks: `matchYield`, `keyword`, `skill`, `tag`,
  `effectDeclaration`, `awaitPending`, `markDestructiveRan`, `rawCode`, the
  five pattern types, `hole`, `codeLiteral`, `splice` are all real members
  (`lib/types.ts:336-392`), so the rest of the table's key set is sound.

---

## Anti-pattern audit (against `docs/dev/anti-patterns.md`)

Requested separately: does the plan's code violate the catalog, and in
particular does it expose declarative interfaces that encapsulate the
imperative work?

### The declarative-interface question, answered directly

This plan is the strongest example of the catalog's good pattern in any of
the recent plans, because its centerpiece is not code at all — it is data.
`LEGAL_AT_TOP_LEVEL` is a `Record<AgencyNode["type"], boolean>`: the entire
rule is a table you read, the "how" is one lookup, and the type system —
not discipline — forces every future node kind through a decision. The two
consumers each add only the imperative minimum (a loop that reports, a
filter that refuses), both call the same predicate, and the global
constraint "the predicate is the only place the rule lives" makes the
what/how separation an enforced property rather than a style choice. The
exhaustive `switch` replacements for the position-message ternaries extend
the same idea. On the question asked: yes, emphatically the good version.

### Hits and near-hits

- **Useless special case, and it fails open: the `inner === undefined`
  guard in the `staticStatement` unwrap.** `StaticStatement` always carries
  a statement — the parser cannot succeed without one
  (`parsers.ts:4560-4563`). The guard handles a state that cannot occur,
  and worse, it answers `true` for it — a malformed static would be waved
  through toward the very crash the predicate exists to stop. Delete the
  branch; if the type genuinely admits `undefined`, failing *closed* is the
  right default for this predicate.
- **Inconsistent patterns: the builder pre-pass hand-builds its message.**
  Ten lines above it, the unfilled-holes refusal renders through
  `renderMessage(DIAGNOSTICS….message, {…})`
  (`typescriptBuilder.ts:508-511`); the plan's snippet concatenates strings
  around `DIAGNOSTICS.topLevelStatementNotAllowed.code` instead. Same
  operation, two shapes, ten lines apart — the catalog's inconsistency
  entry almost verbatim. Use the same rendering path. (Raised in the main
  review as a smaller point; it belongs under this heading.)
- **Duplication check before writing `describeKind`.** A hand list mapping
  node types to human names is the kind of thing the diagnostics layer may
  already own — the plan's own soft spot 3 flags the list as "exactly the
  thing this plan argues against elsewhere". Before writing it, grep for an
  existing type-to-display-name helper (the diagnostics and explanations
  files are the likely owners); if none exists, the local list is fine
  because it fails cosmetic-ugly rather than wrong, as the plan says.

### Where the plan is on the right side of the rest of the catalog

`statementSpliceParser` mirrors `topLevelSpliceParser`'s wrap-and-stamp
shape exactly (consistency, the good direction). The predicate/placement
relationship is the sanctioned answer to near-duplication: two tables with
different jobs, tied by the triangle-closing test rather than left to
agree by luck. Tests are table-driven case lists. Null-prototype record
with `Object.hasOwn` in `describeKind` matches the house pattern.

Checked and clean: no order-dependent mutable state, no nested ternaries
(the unwrap's single ternary disappears with the special-case fix anyway),
no one-line `if`s, no silent catches, no magic numbers, no conditional
spreads, no dynamic imports, no nested type definitions, no
single-character names, and no test whose failure is destructive — the
`rm -rf investigate` in Task 2 Step 7 deletes only the scratch directory
that same step created.

---

## Test plan audit

Requested separately: does each test measure what it claims, will it fail
when the code breaks, and what is missing. Findings 1 and 2 of the main
review (the union-mismatch keys and the `firstNode` import bug) already
cover two test defects and are not repeated. Three new findings, the first
one significant.

### The guarantee layer has no test, and the manual check cannot reach it

The plan's architecture sentence calls the builder pre-pass the layer that
"guarantees no codegen path can reach the crash, whatever else changes" —
and it is the only piece of this plan with **zero automated coverage**. Task
2's unit tests all go through `typeCheck`; the pre-pass is verified only by
Step 7's by-hand CLI compile. I checked the compile path: `buildSession`
runs `typeCheck` before building (`lib/compiler/buildSession.ts:665`), so
the checker's AG3017 fires first and the manual step never executes the
builder throw at all. Delete the pre-pass and every test and manual step in
this plan stays green. That is precisely the drift the pre-pass exists to
prevent. Add a unit test in `lib/backends/` that calls
`TypeScriptBuilder.build()` directly — no type check first — on a program
whose top level holds an `if`, asserting the thrown message carries the
diagnostic code and not `StepPathTracker`. That test is the guarantee; the
manual step is just a demo.

### Body-only statement forms are reachable through Task 4 and tested nowhere

`guard`, `try`, `finalize`, `parallel` and `seq` blocks cannot be parsed at
the top level (parse errors), so no Task 1 or Task 2 test can produce them
— and none does. But Task 4's per-node check runs on **fragment** nodes,
and a statements fragment parses body grammar: `[| guard { … } |]` is a
legal fragment whose nodes include a `guardBlock`. Spliced at top level,
the per-node check is the only thing standing between it and the backend,
and the table entries it consults (`guardBlock: false`, `tryExpression:
false`, …) have no test at all. Two additions: predicate unit tests that
extract these nodes from a *body* parse (parse `node m() { guard { … } }`
and pull the block out) so every `false` row that matters is exercised; and
one Task 4 test splicing a fragment containing a `guard` block, which
proves the fragment path refuses body-only forms, not just the `if` it
shares with the top-level grammar.

### The triangle test pins a copy, not the triangle

The placement-tie test hardcodes the eight type names rather than reading
`TOP_LEVEL_DECLARATION_TYPES` — which is currently module-private
(`nameClassifier.ts:25`), so a copy is the only thing the test *could* use
as written. But a copy is exactly what the test exists to prevent: add a
type to the real placement set and the tie test does not notice. Export the
set (or a read-only accessor) and iterate it. One extra line of API,
and the triangle actually closes.

### Smaller gaps

- **A follow-on from main-review Finding 4:** if the handler wording gets
  its own `AG3018`, Task 2's `handle` test row must assert the new code —
  as written it looks for `AG3017` and would fail after that change is
  applied.
- **Top-level splices keep `"decl"`:** Task 3 pins body → `"statement"` and
  expression → `"expr"` but nothing pins that the top-level form still
  stamps `"decl"` after the new wrapper lands. One test, three lines.
- **The mixed fragment is the spec's motivating example and only implied.**
  The spec's central illustration is one fragment holding `const apiKey =
  getKey()` *and* `if (debug) { … }`. Task 4's bullets test all-legal and
  if-containing separately; make the mixed case explicit so the test suite
  contains the sentence the design was argued from.
- **Multiple offenders:** nothing pins that `checkTopLevelStatements`
  reports every illegal top-level statement rather than stopping at the
  first. Two `if`s, two diagnostics — one cheap test.

### Tests that do their job

For balance, the load-bearing ones that will genuinely fail on regression:
the parsed-node predicate tests (real parser output, so type strings cannot
drift from the grammar); the `static` wrapper pair (both directions);
`handle` in the AG3017 refusal table (the row the spec's first draft got
wrong, now permanently pinned with the wording test); the stamping pair in
Task 3 (remove the wrapper, the `"statement"` assertion fails); the
exhaustive-switch message test (the ternary regression cannot return
silently); and the Task 5 fixture, which fails if any of parse, stamp,
expand, compile, or run regresses on the original report's exact shape.
