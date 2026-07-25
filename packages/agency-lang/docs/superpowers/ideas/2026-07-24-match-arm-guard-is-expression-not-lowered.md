# An `is` expression in a match-arm guard crashes codegen

## Status (2026-07-24)

Idea. Not yet scheduled. Found while probing which pattern forms compile,
during the safeBash matcher design.

Small and self-contained — a good second item, after
[the null-intermediate crash](2026-07-24-object-pattern-crashes-on-null-intermediate.md).

## The Problem

Using the `is` operator in a match arm's guard clause crashes the
compiler:

```ts
match (words) {
  ["echo", str] if (str is string) => "guarded->${str}"
  _                                => "none"
}
```

```
Error: Unhandled Agency node type: isExpression
    at TypeScriptBuilder.processNode (typescriptBuilder.js:557)
    at TypeScriptBuilder.processIfElseWithSteps (typescriptBuilder.js:1220)
```

A crash with a stack trace, not a diagnostic. The same `is` expression in
an ordinary `if` condition works fine, which makes the failure look
arbitrary from the outside.

## Cause

`isExpression` nodes are supposed to be gone by codegen: the pattern
lowerer rewrites each one into its boolean condition form
(`lowerExpression`, `lib/lowering/patternLowering.ts:194`).

`foldArms` (`:859`) builds each arm's condition, and uses `arm.guard`
raw — it is never passed through `this.lowerExpression(...)`. Both
branches drop it in unlowered:

- `:908` — no bindings, the guard is folded in with
  `makeBinOp(condition, "&&", arm.guard, loc)`
- `:912` — with bindings, the guard becomes an inner `ifElse`'s
  `condition: arm.guard`

The arm's *body* is lowered (`:867`, `this.lowerBody(arm.body)`) and the
pattern is lowered via `patternToCondition`. Only the guard is missed.

`:893` (the `guardOnly` branch, for the `match(expr is pattern)` form
where each `caseValue` IS a guard expression) uses
`arm.caseValue as Expression` equally raw, and should be checked for the
same hole.

## Proposed Behavior

Lower the guard like every other expression:

```ts
const guard = this.lowerExpression(arm.guard);
```

and use that at both `:908` and `:912`. Same for `arm.caseValue` in the
`guardOnly` branch at `:893`.

Note `lowerExpression` calls `assertNoBindersInBoolIs` — a guard is a
pure-boolean context, so `if (x is { type: "a", policy })` in a guard
should be the existing "shorthand binders in a pure-boolean context"
compile error, not a new binding. That is the right behavior and comes
for free.

## Touch Points

- `lib/lowering/patternLowering.ts:893` — `guardOnly` caseValue.
- `lib/lowering/patternLowering.ts:897-913` — the two `arm.guard` uses.

## Tests

Agency execution tests (`tests/agency/`):

- `["echo", str] if (str is string)` — arm matches, binding usable.
- Same guard where the test is false → falls through to the next arm.
- A guard using `is` with a named type (`if (p is Person)`), which routes
  through schema validation rather than a coarse check.
- `match(expr is pattern)` form with an `is` inside an arm's condition.
- A guard containing a shorthand binder → the existing compile error, not
  a crash and not a silent binding.
- Regression: a guard with no `is` still compiles to the same output
  (fixture check).

## Related

- `docs/site/guide/pattern-matching.md` — guard clauses and the `is`
  operator; the interaction of the two is currently undocumented.
- `lib/lowering/patternLowering.ts:194` `lowerExpression` — the pass the
  guard is skipping.
