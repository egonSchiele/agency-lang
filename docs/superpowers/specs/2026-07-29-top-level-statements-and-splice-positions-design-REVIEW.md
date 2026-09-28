# Review: top-level statements and splice positions spec

Reviewed spec: `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-29-top-level-statements-and-splice-positions-design.md`

Every code citation was re-verified, and I re-measured the rows of the
behavior table that looked suspicious. The design is right — one predicate,
exhaustive over the node type, consumed by both the compile path and the
splice checker, is exactly the shape this problem wants, and the "placement
vs legality" distinction around `TOP_LEVEL_DECLARATION_TYPES` is drawn
correctly. Two findings are significant: one measured row of the table is
wrong in a way that involves handler safety, and Part 3 has a smuggling hole
the spec closes only by an ordering requirement it never states.

## Finding 1 (factual error, safety-relevant): top-level `handle` blocks crash — they are not a parse error

The table lists `handle read(p) { … }` as "parse error" and the Why section
says `guard`, `try` and `handle` "are absent" from the top-level
alternation. Both are wrong for `handle`:

- `handleBlockParser` **is** in `nodeParser` (`lib/parser.ts:90`).
- Measured on this checkout: the block form parses and crashes —

  ```
  handle {
    print(1)
  } with (e) {
    approve()
  }
  ```

  compiles into the same `StepPathTracker: currentId() called with empty
  path` crash as the `if` row.

The effect-scoped form the spec tested may well be a parse error, but the
block form belongs in the crash group. This matters more than a normal table
correction: handlers are safety infrastructure in this codebase — a
top-level `handle` is a handler the author believes is registered, reaching
a code path that crashes today and that a wrong fix could route into
`__initializeGlobals` where it would silently never register. The
not-allowed list already includes `handle`, so the *rule* is right; the
measurement and mechanism text need correcting, the crash-table test needs
the block-form row, and the diagnostic for this case deserves wording that
tells the author where handlers may live.

Worth saying out loud: this error is the spec's own thesis demonstrating
itself. A statement form nobody considered sat in the grammar's list, and a
hand-maintained table missed it. The exhaustive-switch predicate is the fix
for exactly this, which strengthens Part 1's argument.

## Finding 2 (structural gap): a `program` fragment can smuggle the crash past Part 3

Part 3's rule is "accept a `program` fragment, or a `statements` fragment
every node of which satisfies the predicate." But the grammar accepts `if`
at the top level — that is the bug — so `parseProgram("if (true) { }")`
yields a perfectly good `program` fragment containing a crash. A generator
returning it passes the splice check unexamined, and the per-node scrutiny
applies only to the `statements` kind.

The spec's implicit answer is Part 1's compile-path check — but that
backstop only exists **if the structural check runs on the post-expansion
AST**, and the spec never states where in the pipeline the check runs beyond
"alongside the other structural checks before codegen". Splice expansion has
five entry paths (per `docs/dev/splices.md`), so this ordering constraint is
load-bearing and easy to get wrong per-path. Required changes: state the
ordering requirement explicitly (the check must see expanded output on every
path that expands splices), name the pass it lands in, and add the test — a
top-level splice whose generator returns a `program` fragment containing an
`if` produces a diagnostic, not a crash. Optionally run the per-node check
on `program` fragments too at the splice site, purely for the better
message that names the generator; the spec's Part 3 wording currently
promises that message only for `statements` fragments.

## Finding 3 (concrete, small): `position` has message-building consumers the spec does not list

Adding `"statement"` to `Splice["position"]` is type-forced through the
kinds table — `KINDS_FOR_POSITION` is `Record<Splice["position"], string[]>`
(`lib/preprocessors/expandSplices.ts:465`), so the new entry cannot be
forgotten. But two lines below the table lookup, the AG8007 message is built
with binary ternaries (`expandSplices.ts:556-557`):

```ts
expected: splice.position === "decl" ? "program" : "expr",
position: splice.position === "decl" ? "declaration" : "expression",
```

A third position value flows through these silently and mis-describes a
statement-position mismatch as "expression position needs an expr fragment"
— the exact confusion Part 2 exists to remove. The spec should list these as
consumers to update, and the same exhaustive-switch treatment it prescribes
for the predicate applies here.

## Finding 4 (measure before allowing): top-level `interrupt` needs a row in the table

The allowed list includes interrupt expression statements, mirroring
`staticStatementParser` (verified — `parsers.ts:4706-4710` is exactly the
`or(interruptStatementParser, functionCallParser, valueAccessParser)` the
spec quotes). But the table never measures a bare top-level
`interrupt("x")`, and there is a known constraint that interrupts need a
running node — anything at static-init time cannot be gated the normal way.
`static interrupt(...)` was a deliberate design with its own routing;
whether a *plain* top-level interrupt fires, no-ops, or breaks today is not
established anywhere in the spec. Measure it and record the result in the
table before the rule enshrines it as allowed. If it turns out broken, that
is a separate bug, and the allowed list should cite the static form as the
supported spelling.

## Smaller points

- **Tie the three lists together with a test.** After this change, three
  things describe the top level: the grammar alternation (permissive, by
  design), `TOP_LEVEL_DECLARATION_TYPES` (placement), and
  `isLegalAtTopLevel` (legality). The spec separates the roles well; one
  cheap test closes the triangle — every type in the placement set (plus
  the static-assignment special case, `nameClassifier.ts:105-109`)
  satisfies the predicate, so placement can never drift into emitting an
  illegal node.
- **`x = 1` at file scope.** The table says it compiles and the allowed
  list keeps it. Inside bodies, assignment to an undeclared name is
  rejected. If top-level bare assignment really is legal today, keeping it
  is the right conservative call, but one sentence acknowledging the
  asymmetry would stop a reader from "fixing" it in passing.
- The diagnostic wording in Part 1 is good; give it a diagnostic code in
  the AG-numbered space like its neighbors, and the spec should say which.

## Claims verified as correct

- The top-level alternation contents (`lib/parser.ts:75-96`): `ifParser`,
  `forLoopParser`, `whileLoopParser`, `matchBlockParser`,
  `messageThreadParser` present as claimed; `returnStatementParser` and
  `gotoStatementParser` present, matching the "compiles today" rows;
  `guard` and `try` genuinely absent. (`handle` — see Finding 1.)
- `TOP_LEVEL_DECLARATION_TYPES` and the static-assignment special case are
  as described (`nameClassifier.ts:100-109`), and the doc comment confirms
  it answers placement, not legality — the spec's distinction is real.
- `Splice["position"]` is `"decl" | "expr"` (`lib/types/splice.ts:20`);
  `KINDS_FOR_POSITION` is exactly as quoted, and its own comment explains
  why `"statements"` sits in `decl` (smallest-first kind inference stops a
  lone `const` at `statements`) — which confirms the spec's "cannot simply
  be deleted" argument.
- The body-level splice alternative really does leave position as `"expr"`
  — the comment at its registration site says "Position stays 'expr' — only
  the top-level parser stamps 'decl'", which is Part 2's mechanism,
  verbatim.
- `staticStatementParser`'s inner parser matches the spec's quote exactly,
  so "someone answered this question once already" is accurate.
- The exhaustive-switch precedent (`identifierSlots.ts` typed over
  `AgencyNode`) is real and is the right pattern to copy.

## Test additions implied

The block-form `handle` crash row (Finding 1); the program-fragment-with-
`if` splice (Finding 2); a statement-position splice kind-mismatch asserting
the *message* names statement position (Finding 3); the measured top-level
`interrupt` row (Finding 4); and the placement-set-implies-legality tie
(smaller points).
