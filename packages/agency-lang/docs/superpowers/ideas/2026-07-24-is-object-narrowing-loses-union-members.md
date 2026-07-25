# `is object` narrows a union to opaque `object`, losing its members

## Status (2026-07-24)

Idea. Found while fixing
[the object-pattern shape check](2026-07-24-object-pattern-crashes-on-null-intermediate.md),
which is shipping a workaround for it rather than a fix.

Not urgent — the workaround costs one comparison and nothing is broken —
but the gap will bite again wherever `is object` meets a union.

## The Problem

Narrowing by `is object` replaces the type with the opaque `object` type
instead of filtering the union's object-like members:

```ts
type Redirect = { op: string, path: string }

def f(r: Redirect | null): string {
  if (r is object) { return r.op }   // error AG2011:
  return "no"                        //   Property 'op' does not exist on type 'object'
}
```

The test proves `r` is a non-null object, and the only non-null member of
`Redirect | null` is `Redirect`, so `r` is a `Redirect` in that branch.
The checker instead lands on `object`, which has no fields at all.

The null check narrows correctly, which makes the contrast sharp:

```ts
if (r != null) { return r.op }   // fine
```

## Why it matters

Object patterns emit a shape check before reading fields (see the linked
idea). The natural check is the coarse `is object` test, and on its own it
would make every pattern that reads through a nullable field fail to
typecheck — `{ redirect: { op: ">" } }` against a `Redirect | null` field
would report AG2011 even though it runs correctly.

The workaround shipped in `shapeCheck` (`lib/lowering/patternLowering.ts`)
is to emit **both**, null check first:

```ts
source != null && __coarseTypeTest(source, "object")
```

The `!= null` does the union filtering, and the coarse test that follows
does not clobber it. That composes today and is verified by tests, but it
means the generated condition carries a redundant comparison purely to
work around the narrowing, and the comment there has to explain why.

## Proposed Behavior

Narrowing by a coarse type test should FILTER a union, the way
`narrowUnionByDiscriminant` does, rather than replace it:

- `Redirect | null` narrowed by `is object` → `Redirect`
- `Redirect | string | null` by `is object` → `Redirect`
- `Redirect | Other | null` by `is object` → `Redirect | Other`
- A non-union, non-object type by `is object` → unchanged behavior
- Nothing object-like in the union → fall back to today's `object`, never
  to `never`

The same argument applies to the other coarse kinds: `is string` on
`string | null` should give `string`, `is any[]` on `Foo[] | null` should
give `Foo[]`. Worth checking whether those already work or share the bug.

Once this lands, `shapeCheck` can drop the `!= null` half and emit just
the coarse test — smaller generated conditions, and one mechanism instead
of two.

## Touch Points

- `lib/typeChecker/narrowing.ts` — the coarse-test narrowing path; model on
  `narrowUnionByDiscriminant` (`:319`), which already filters members
  soundly and never narrows to `never`.
- `lib/lowering/patternLowering.ts` `shapeCheck` — simplify once fixed.
- `docs/site/guide/pattern-matching.md` — "Narrowing is positive-only …
  `object` narrows to the opaque `object` type" describes today's
  behavior and would need updating.

## Tests

- Each bullet under Proposed Behavior as a typecheck test.
- The union-flattening interaction: a union whose member is itself a union
  alias (see PR #674) narrowed by `is object`.
- Regression: `is object` on a plain `any` still gives opaque `object`.

## Related

- [Object pattern crashes on a null intermediate](2026-07-24-object-pattern-crashes-on-null-intermediate.md)
  — carries the workaround.
- PR #674 — union flattening in `resolveType`, same family of union
  handling.
