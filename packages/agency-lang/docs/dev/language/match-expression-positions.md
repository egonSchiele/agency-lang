# Where a `match` expression is allowed

`match` is not an ordinary expression as far as the parser is concerned. It is
**not** part of `exprParser`. Instead there is a separate `matchBlockExprParser`
(`lib/parsers/parsers.ts`) that gets wired into each place a match is allowed to
appear as a value, by hand, one site at a time.

Today there are three such sites:

1. `returnStatementParser` — `return match(x) { ... }`
2. `assignmentParser` — `const y = match(x) { ... }`
3. the match-arm body — `success(s) => match(y) { ... }` (added for #887)

If you want `match` to be legal somewhere new, adding it to that site's
alternatives is the whole parser change. `if ... then ... else` works the same
way, through `ifExpressionParser`, but is wired into only the first two.

This is deliberate. Folding `match` into `exprParser` would make it legal
everywhere an expression is — as a function argument, as an operand of `+`, and
inside the head of another match. That is a much larger ambiguity surface than
the feature is worth, and the owner has explicitly ruled it out.

## The trap: a nested match must be lowered, not hoisted

`matchBlock` is in the `Expression` union and in `EXPRESSION_NODE_TYPES`
(`lib/types.ts`), so a single-expression match arm whose body is a nested match
will happily take the generic "hoist the arm's value to a temp" path in
`rewriteArmForYield` (`lib/lowering/patternLowering.ts`). That path leaves the
raw `matchBlock` node as the yield's `typeSource`.

The synthesizer has no case for `matchBlock`, so synthesizing that node returns
`any`. And in `computeMatchExprTypes`, **one** `any` yield makes the entire
match's value type `any`:

```ts
ctx.matchExprTypes[id] = types.some(isAnyType)
  ? ANY_T
  : unionTypes(types.map((t) => widenType(t)));
```

(`lib/typeChecker/matchExprTypes.ts`)

So the failure is not "the nested match is untyped". It is "the whole outer
match is untyped", and every assignability check on it silently stops running.
Nothing errors; you just lose the checking.

So `rewriteArmForYield` lowers the nested construct first and yields its
`__matchval_<id>` ref, exactly what `rewriteReturnsToYields` does for
`return match(...)` in a block arm. `computeMatchExprTypes` processes match ids
in DESCENDING order precisely so these resolve bottom-up.

It routes through the shared `expressionRegion()` helper, which owns the
question "is this an expression-position control-flow construct?" for
`matchBlock` and `ifElse` alike. The arm lowerer adds the one question only it
can answer: **is this arm an expression position?**

That second question is load-bearing, not ceremony. `ifElse` is one node type
for two surface forms (see the last section), and is an expression only in value
position — for an arm, the inline form. A BLOCK arm whose body is a lone
statement `if` must NOT take this path: `lowerIfExpressionCore` reads each
branch as `thenBody[0] as Expression`, so a branch like
`{ const x = 41  return x + 1 }` yields the value of the `const` binding and
silently drops the `return`. Calling `expressionRegion()` ungated on every
one-node arm body makes this arm return 41:

```agency
true => {
  if (c) { const x = 41  return x + 1 } else { return 2 }
}
```

and makes an arm whose branches yield nothing at all compile silently instead of
raising "match arm must return a value on every path". `matchBlock` has no such
ambiguity — it is an expression in both forms — so it takes the path either way.

Anything else you make legal in a value position needs the same treatment: if
the synthesizer cannot type the node, hoisting it poisons its consumer.

## Known limitation: a nested arm loses literal types

The yield this produces carries no `typeSource`, so `computeMatchExprTypes`
types it by synthing the `__matchval_<inner>` ref, and that hook returns
`ctx.matchExprTypes[inner]` — which has already been through `widenType`. A
nested arm therefore loses literal types, and a literal-union annotation gets a
false error:

```agency
const val: "a" | "b" = match(r) {
  success(v) => match(r2) { success(w) => "a"  failure(e) => "b" }
  failure(e) => "a"
}
// Type 'string' is not assignable to type '"a" | "b"'
```

Flattened to a single match this is accepted, because a plain arm keeps its
`typeSource` and the per-arm check runs on the UNWIDENED type. This is not new —
`=> { return match(...) }` has always behaved this way — but the inline syntax
is what makes the shape easy to reach.

If you want to close it: the unwidened per-arm types do exist, in
`ctx.matchExprYieldTypes[inner]`. The nested yield would need to carry them
through rather than collapsing to the widened union.

## The formatter has to agree

`armPrintsInline` (`lib/backends/agencyGenerator.ts`) decides whether an arm
prints as `=> expr` or `=> { ... }`. The author's form wins: the parser sets
`blockBody` on an arm written as a block, and that arm prints as a block. The
shape tests only decide for ASTs built programmatically, where no form was
recorded. Those tests must not print inline a shape the arm grammar cannot
re-parse, which is the `#708` rule in the doc comment.

The check is now an allow-list, `INLINE_ARM_STATEMENT_TYPES`, holding the three
statement types the single-statement arm grammar accepts alongside expressions:
`returnStatement`, `gotoStatement`, and `assignment`. It replaced a
`NEVER_INLINE_ARM_TYPES` deny-list that existed for exactly one entry,
`"matchBlock"`, because the grammar used to reject inline nested matches.

The whole-corpus print→reparse identity test in
`lib/backends/agencyGenerator.roundtrip.test.ts` is what catches a mistake here,
but only for shapes the corpus actually contains — add a targeted case too.

## Known gap: `if ... then ... else` as an arm body

Still a parse error. The parser half is one line — add `ifExpressionParser` to
the arm alternatives — and the lowering half really is done: because
`rewriteArmForYield` routes through `expressionRegion()`, which already handles
`ifElse`, adding that one parser line is enough to make

```agency
match(x) {
  1 => if (x > 0) then 10 else 20
  _ => 0
}
```

parse, lower, and run correctly. I verified this by temporarily adding the line.

What is NOT done is the formatter, and it fails loudly rather than subtly. With
the parser line in, `agency fmt` prints the arm above as:

```
1 => {
  if (x > 0) {
10
  } else {
20
  }
}
```

— structurally broken, and even repaired it would re-parse as a statement `if`
whose branches contain no `return`, which dies with "match arm must return a
value on every path".

The cause is the two-surface-forms problem again: nothing on an `ifElse` node
records which form was written, and `armPrintsInline` /
`processMatchBlockCase` fall back to the statement printer. Existing code
disambiguates **by position** — see the comment at the assignment-value branch
in `agencyGenerator.ts`, "a statement `if` is never an assignment value". An
inline arm body is a value position, so the same argument works; both the
inline decision and the printing path need to route through
`formatIfExpression`. That, plus a round-trip test, is the whole remaining job.
