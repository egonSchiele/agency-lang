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
ctx.matchExprTypes[id] = types.some(isAnyType) ? ANY_T : ...
```

So the failure is not "the nested match is untyped". It is "the whole outer
match is untyped", and every assignability check on it silently stops running.
Nothing errors; you just lose the checking.

The fix is for `rewriteArmForYield` to lower a nested match through
`lowerMatchExpressionCore` first and yield its `__matchval_<id>` ref — exactly
what `rewriteReturnsToYields` already does for `return match(...)` in a block
arm. `computeMatchExprTypes` processes match ids in DESCENDING order precisely
so these resolve bottom-up.

Anything else you make legal in a value position needs the same treatment: if
the synthesizer cannot type the node, hoisting it poisons its consumer.

## The formatter has to agree

`armPrintsInline` (`lib/backends/agencyGenerator.ts`) decides whether an arm
prints as `=> expr` or `=> { ... }`. It must not print inline a shape the arm
grammar cannot re-parse — that is the `#708` rule in its doc comment. A
`NEVER_INLINE_ARM_TYPES` list used to exist for exactly one entry,
`"matchBlock"`, because the grammar rejected inline nested matches. Once the
parser accepted them the list was empty and was deleted.

The whole-corpus print→reparse identity test in
`lib/backends/agencyGenerator.roundtrip.test.ts` is what catches a mistake here,
but only for shapes the corpus actually contains — add a targeted case too.

## Known gap: `if ... then ... else` as an arm body

Still a parse error. The parser half is one line (add `ifExpressionParser` to
the arm alternatives) and the lowering half is already written — the shared
`expressionRegion()` helper handles `matchBlock` and `ifElse` both. The reason
it is not done is the formatter.

`ifElse` is one node type for two surface forms: the statement `if (c) { ... }`
and the expression `if c then a else b`. Nothing on the node records which was
written. Existing code disambiguates **by position** — see the comment at the
assignment-value branch in `agencyGenerator.ts`, "a statement `if` is never an
assignment value". An inline arm body is a value position, so the same argument
works there, but `armPrintsInline` and the arm-printing path both need to know
it, or the arm prints in statement form and stops round-tripping.
