# Review: code-literal parse and print fixes spec

Reviewed spec: `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-28-code-literal-parse-and-print-fixes-design.md`

Every factual claim below was checked against the code today, not taken from
the spec. Where I could not fully re-verify something, I say so.

## Verdict

The diagnosis in both parts is correct and well-evidenced. Part 2's fix is
right and ready to implement, with one factual error in its ordering
description that must be corrected first. Part 1's fix is the right shape but
has two real problems: the routing rule as written breaks legal bodies that
use a keyword as an ordinary variable name, and one keyword in the routing
table (`effect`) is justified by a claim the parser contradicts. Both are
fixable inside the spec's own design; neither requires rethinking the
approach.

---

## Finding 1 (major): the routing rule breaks keyword-as-identifier bodies

The spec's peek rule is "keyword followed by something that cannot continue
an identifier". The spec itself proves that `node`, `type`, and the other
routed words are legal variable names today (`const node = 1` compiles). Put
those together and the rule misroutes every expression body that *uses* such
a variable:

- `[| node |]` — a bare reference to a variable named `node`. Today: kind
  `expr`. Under the rule: `node` followed by end-of-input routes to the
  program parse, which fails, and per the spec's no-fallback policy the user
  gets a hard error about a node declaration they never wrote.
- `[| node.run() |]`, `[| node + 1 |]`, `[| node[0] |]` — same story. A dot,
  a plus, a bracket: none of those can continue an identifier, so all of
  these route and hard-fail.

This directly contradicts the Risk section, which claims "no body which
parses today as `statements` or `expr` changes its kind" apart from `type`.
That claim is false as the rule is currently written.

**Suggested repair, staying inside the spec's design:** peek for the
*declaration shape*, not just the keyword. For `node` and `def`, route only
when the keyword is followed by whitespace and then an identifier — that is
the declaration-name position, and it is exactly the shape that mis-parses
today (`node` as a name followed by `main()` as a call requires an
identifier after the keyword). `node.run()` has a dot next, `node + 1` has
an operator, bare `node` has end-of-input; none route. For `import`,
`export`, and `static`, peek for what legally follows in a declaration
(`{`, an identifier, a string, or a declaration keyword). This keeps the
one-sentence spirit — "a body that starts like a declaration is a program" —
while making the Risk claim true again.

Residual case worth naming in the spec: `[| node
main() |]` where `node` really is a variable and `main()` really is a call on
the next line. The declaration-shaped peek still routes that and hard-fails.
I think that trade is right — that body is indistinguishable from the bug
being fixed — but the spec should say it out loud rather than imply zero
regressions.

## Finding 2 (major): `effect` and `effectSet` do not belong in the "safe" routing set

The keyword table justifies routing `effect`/`effectSet` with "Effect
declarations are top-level only." The parser says otherwise:
`effectSetDeclParser` and `effectDeclParser` are alternatives inside
`_bodyNodeParser` (`packages/agency-lang/lib/parsers/parsers.ts:4578-4579`),
the parser for function and node bodies. So a literal body starting with
`effect` parses successfully as `statements` today, and routing it changes
observable behavior — the same situation the spec carefully treats as an
open question for `type`.

I have verified only the syntactic fact (the parsers are in the body
alternatives list); I did not chase whether an effect declaration in a body
is semantically meaningful downstream. Either way, the table's justification
is wrong, and `effect`/`effectSet` should move out of the confidently-safe
set and into the same explicit-decision bucket as `type`, with the same
"kind flips from statements to program" cost stated.

## Finding 3 (must fix before implementing): Part 2's pass ordering is wrong

The spec says "passes 1, 2 and 4 (type aliases, node names, tools) run
*before* the partition today and read the original stream; passes 3 and 5
run *after*." The code disagrees: in `AgencyGenerator.generate`
(`packages/agency-lang/lib/backends/agencyGenerator.ts:198-239`), the
partition happens at line 222-224, pass 3 (node imports) starts at line 227,
and pass 4 (tools) starts at line 234. So passes 1 and 2 read the original
stream; passes 3, 4, and 5 read the partitioned one.

This matters because the spec's instruction is "each pass keeps reading the
stream it reads today." Following the spec as written would move pass 4 onto
the original stream, which changes the order tool code lands in
`generatedStatements` whenever the partition reorders anything around a
function. The byte-identical golden test the spec asks for would likely
catch the mistake, but the spec should not require the implementer to
discover the error via a failing golden. Correct the sentence to: passes 1
and 2 read `program.nodes`; passes 3, 4, and 5 read the partitioned local.

## Finding 4: first-word routing leaves two known holes — say so

The proposed fix peeks only at the first word of the body. Two confirmed-bug
shapes survive it:

1. **A declaration after a statement.** `[| print(1)
   node main() { } |]` starts with `print`, so it is never routed. The
   statements attempt reads `node` as a name and `main()` as a call, exactly
   the original bug. And since a bare call is legal at file top level (the
   spec verified this), that body is a legal program the user plausibly
   meant. The rejected-alternatives section's "reject a bare keyword used as
   a whole statement" idea is the natural defense in depth here; the spec
   already gestures at doing it later, but it should explicitly connect it
   to this residual case.
2. **`static const` after the first statement.** `[| const a = 1
   static const x = 2 |]` starts with `const`, so it is not routed. The
   statements attempt reaches `bodyReservedModifierParser`, which reports
   through tarsec's `parseError` — and `parseError` throws on failure
   (verified in `node_modules/tarsec/dist/combinators.js:977-988`, it
   constructs and throws a `TarsecError`). The throw escapes before the
   program attempt runs, so this body still hard-fails after the fix even
   though it is a legal program. If this is worth fixing now, the targeted
   repair is to catch the throw around the statements attempt inside
   `parseCodeLiteralBody` and convert it into an ordinary attempt failure so
   the program attempt still runs. If not, name it as a limitation.

Neither hole invalidates the fix. But the spec currently reads as though
first-word routing closes the bug class, and it closes only the
declaration-first instances of it.

## Finding 5: the `type` open question understates its blast radius

The open question frames the cost of routing `type` as "an observable change
to `kind` for type-alias-only literals." It is a bit wider: routing peeks at
the first word, so *any* multi-statement body that begins with a type alias
is affected. `[| type P = { n: number }
const x = 1 |]` flips from `statements` to `program` (both parses succeed).
Worse, `[| type P = { n: number }
return 1 |]` — legal as statements today, since `return` is a body statement
— would route to the program parse and hard-fail, because `return` is not
legal at top level. If `type` goes in the routing set, the spec should state
both costs, not just the kind flip. (A declaration-shaped peek from Finding
1 does not help here; these bodies genuinely start with a type alias.)

## Claims I verified as correct

So the next reader does not have to re-check them:

- All cited line numbers resolve to what the spec says they are:
  `parseCodeLiteralBody` at `parsers.ts:3044` with the three attempts at
  3059/3063/3067 in that order; `RESERVED_WORDS` at 213;
  `bodyReservedModifierParser` at 4451; `literalTrivia` at 1493;
  the mutation `program.nodes = this.partitionImports(...)` at
  `agencyGenerator.ts:223`.
- `RESERVED_WORDS` really has exactly one non-test consumer: the import in
  `lib/runtime/template/fill.ts:3`, used at line 266 for identifier-hole
  validation.
- `this.program = program` at `agencyGenerator.ts:201` is written and never
  read; grep finds no other reference. The dead-field cleanup claim holds.
- Statics being deep-frozen is confirmed by the comment and design at
  `lib/typeChecker/staticInitRules.ts:114-124` ("Statics are `__deepFreeze`d
  at init time, so any actual mutation throws a clean `TypeError`").
- `parseError` throwing (rather than returning a failure) is confirmed in
  tarsec's source, which supports the spec's account of why
  `[| static const x = 1 |]` never reaches the program attempt.
- The existing trivia-stripping in `parseCodeLiteralBody` (lines 3045-3055)
  handles whitespace and blank-line sentinels but not comments, so step 1 of
  the proposed fix (reuse `literalTrivia` to also skip comments) is needed
  for the comment-first case, as the spec says.

One claim I did not independently re-verify: that the `parseError` throw
escapes `runNested` uncaught. The spec's error transcript matches
`BODY_RESERVED_MODIFIER_MESSAGE` exactly and the repro files exist in
`packages/agency-lang/investigate/`, so I believe it, but the implementer
should keep the repro handy.

## Test additions the findings imply

Beyond the spec's list, which is otherwise good:

- `[| node |]`, `[| node.run() |]`, `[| node + 1 |]` stay `expr` (Finding 1
  regression guards). Same for whichever of `type`/`effect` end up routed.
- The two Finding 4 shapes, asserted either as fixed (if the defense-in-depth
  or throw-catch lands) or as known-limitation tests with a comment saying
  the failure is accepted, so a future change to them is noticed.
- If `type` is routed: the mixed `type`-then-`return` body from Finding 5,
  asserted with whatever behavior is decided.
