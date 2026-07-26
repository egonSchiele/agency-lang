# Review: array patterns — exact length, and a rest binder anywhere

Review of [the spec](2026-07-25-array-pattern-length-and-middle-rest-design.md),
2026-07-25.

## Status: addressed

Items 2, 3, 4, 5 and both Smaller items are folded into the 2026-07-25
revision of the spec. Item 1 (the rest-binder type suffix) is deferred to
Part 3, which the revision adds with both semantics readings recorded.

Kept alongside the spec so the reasoning behind those revisions stays
findable. Nothing here is still open.

## Verdict

Ready to implement once the gaps below are closed. The diagnosis in Part 1 is
right, the language table is the correct frame for "is a middle rest exotic",
and the performance section pre-empts the obvious objection with numbers
instead of assertion. Rejecting a separate one-or-more sigil is well argued —
`["a", mid, ...rest, "c"]` really does say the thing, and no language in the
table disagrees.

Two things I checked that hold up:

- The tail arithmetic. `xs[xs.length - tail.length + i]` is correct, and the
  worked example against `["a","b",...rest,"d","e"]` indexes the right
  elements.
- Part 1's cause. `hasRest ? ">=" : ">="` reads as an unfinished edit, not a
  decision — same conclusion I reached reviewing #676, where the line is
  adjacent to that change.

## 1. The headline examples use syntax that does not parse

Lines 77–78 both write `...rest: string[]`:

```ts
["echo", a: string, b: string, ...rest: string[], last: string]
```

That does not parse today:

```
["echo", ...rest: string[]] => "yes"
Failed to parse: expected match cases of the form `value => expression`
```

`takesTypeSuffix` (added in #695) admits `variableName`, `objectPattern`,
`arrayPattern` and `wildcardPattern` — not `restPattern`. So Part 2 as written
needs a third change, and that change appears only as a Tests bullet (line
241). It is absent from Semantics, Lowering, Errors and Sequencing.

It also opens a semantics question the spec never answers: **what does
`...rest: string[]` test?** Two readings, and they are not close:

- Validate the slice element-wise against `string[]`. Cost scales with the
  slice length, and by #695's own measurements a named type runs ~370 ns per
  value — which would dominate every number in the performance table.
- Assert only that the slice is an array. Always true, so the suffix is a
  no-op and should probably be rejected rather than accepted.

**Recommendation:** drop the suffix from the Part 2 examples so Part 2 is
exactly what it claims, and give the rest-binder suffix its own part with its
own semantics. As written the spec's two most prominent lines describe
something it does not plan to build.

## 2. The impact analysis counts match arms; `is` positions change too

`if (xs is ["a", "b"])` parses and prefix-matches today — confirmed against a
current build. `while` conditions and `match (x is [...])` heads route through
the same `patternToCondition`, so Part 1 changes all of them.

The count is genuinely zero in this repo, so "provably this small" survives
intact. But **"Array patterns in match position: 15"** reads as though match
arms were the whole surface, and `docs/site/guide/pattern-matching.md`
documents `is` with array patterns — so a reader checking their own code
against this table would check the wrong construct.

State the constructs, not only the count.

While there: say explicitly that **binding position is untouched**.
`const [a, b] = xs` goes through `extractBindings`, which emits no length
check at all, so Part 1 cannot affect destructuring. Every reader will wonder;
the spec never says.

## 3. "Exactly today's output" has to be a deliberate branch

`sliceCall(source, start)` (`patternLowering.ts:1413`) emits a start-only
slice. The two-sided form produces `xs.slice(2, xs.length - 0)` when `tail` is
empty unless the one-argument form is kept explicitly.

The spec asserts the prefix case is "unchanged rather than reimplemented"
(line 184). That holds only if the branch is written down as a requirement.
Otherwise every existing rest fixture churns, and a diff where the interesting
change is buried in fixture noise stops being reviewable.

Worth recording the good news too: `AccessChainElement` is already
`{ kind: "slice"; start?; end? }` (`lib/types/access.ts:7`), so the two-sided
slice is a parameter to machinery that exists, not a new IR node.

## 4. "Reject with a diagnostic" does not say which mechanism

`enforceRestAtEnd` lives in the parser (`parsers.ts:5846`). Diagnostics with
AG codes come from the typechecker registry, so a parser cannot emit one.

The Errors section therefore has an unresolved choice: either this becomes a
good **parse error message**, or the check **moves to the typechecker** so it
can carry a code. Since the spec's own complaint is that users get a stack
trace instead of a diagnostic, it should say which, and pick the number.

## 5. Two missing rows in the semantics table

- **Rest first** — `[...rest, "c"]`. The minimal middle-rest case, and the one
  most likely to expose an off-by-one in the tail arithmetic, since `head` is
  empty. Neither the table nor the Tests section has it.
- **Rest alone** — `[...rest]`, where head and tail are both empty.

One line each, in the table and in Tests.

## Smaller

- The impact table's `affected` column means "meaning changes", but the prose
  immediately explains that no result changes. Renaming it ("meaning changes")
  removes the contradiction.
- Part 1 is a silent behavior change with no diagnostic, accepted for good
  reasons. That makes a changelog entry the only signal users get — worth
  naming as a deliverable of that PR rather than leaving it implied.

## Sequencing

Splitting Part 1 into its own PR is the right call, and the reason given —
build Part 2 on a base that is known correct — is the right reason.

One addition: if the rest-binder type suffix stays in scope at all, it should
be a third PR after Part 2, not folded into it. It is a parser change plus a
semantics decision, and it shares nothing with the length arithmetic that
makes Parts 1 and 2 one design.
