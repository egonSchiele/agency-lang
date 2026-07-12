# Normalize `undefined` → `null` at index and match value sites

**Issue:** [#409](https://github.com/egonSchiele/agency-lang/issues/409) — "object lookup with missing key should yield null (not undefined)"

**Status:** Design approved; ready for implementation plan.

## Problem

Agency has exactly one nothing-value: `null`. Users cannot write `undefined`, and
`docs/dev/null-and-undefined.md` commits the language to *absorbing* any `undefined`
that the JS runtime produces into `null` so it is "never a distinct concept a user has
to reason about."

That absorption was only ever finished on the **comparison** side: `==`/`!=`/`===`/`!==`
lower to `__eq`, which makes `null == undefined`. The **value** side was left undone.
So a missing lookup produces a literal `undefined` value that then flows through the
program — printed, interpolated into strings, stored in threads, serialized to JSON,
passed to tools — as `undefined`, not `null`:

```ts
const val = obj[key]   // key not in obj  ->  val === undefined  (should be null)
```

`__eq` hides this only at comparison sites. Everywhere else the raw `undefined` is
observable, breaking the "only `null` exists" invariant.

## Scope

This fix covers the two value-leak sites the issue names (the lookup itself and its
`match` companion):

1. Object missing key — `obj[key]`
2. Array out-of-bounds — `arr[i]` (shares the same codegen path as #1, so free)
3. `match` expression with no matching arm (and no `_` wildcard)

**Out of scope** (deferred to follow-up issues; listed in `null-and-undefined.md`):
optional chaining `a?.b`, destructuring a missing field, a function that falls off the
end without `return`, and TypeScript-interop returning `undefined`.

## Non-goals

- **No type-checker changes.** Index and match result *types* stay as they are. Making
  them `T | null` and forcing narrowing is "Project 2" strict null checking
  (`null-and-undefined.md`, "Relationship to null safety"), a separate effort. Because
  the value at these sites was already `undefined` — an equally-nullish value — swapping
  it for `null` introduces no new "possibly null" type errors and no regression.
- **No change to match arm *comparison*.** Arms compare with raw `===`, so a `null`
  scrutinee will not match an interop `undefined` case. That is a matching-semantics
  concern, distinct from the result *value* this fix addresses, and stays as-is.

## Design

### Core mechanism: a `__nn` runtime helper

Add a nullish-normalize helper that mirrors the existing `__eq` helper in structure and
wiring.

`lib/runtime/nn.ts`:

```ts
/**
 * Nullish-normalize: collapse `undefined` into Agency's single nothing-value,
 * `null`. Wraps the value sites where the JS runtime produces `undefined`
 * (missing object key, out-of-bounds index, unmatched `match`) so the
 * "only null exists" invariant holds at the value level, not just at `__eq`.
 *
 * `x ?? null` returns `null` for `null`/`undefined` and `x` unchanged for every
 * other value (including `0`, `""`, `false`, `NaN`). The operand is evaluated
 * exactly once, so wrapping a side-effecting expression is safe.
 *
 * See docs/dev/null-and-undefined.md.
 */
export function __nn<T>(x: T): T | null {
  return x ?? null;
}
```

Wiring (identical to `__eq`'s three touch points):

- Export from `lib/runtime/index.ts` (`export { __nn } from "./nn.js";`).
- Add `__nn` to the runtime import list in
  `lib/templates/backends/typescriptGenerator/imports.ts`.
- Emit at call sites as `ts.call(ts.id("__nn"), [expr])`.

A helper is chosen over an inline `(expr ?? null)` for consistency with `__eq`: it is
greppable, centralizes the semantics in one documented place, and reads in generated
code the same way comparisons already do.

### Fix 1 — index reads (issue sites #1 and #2)

In `lib/backends/typescriptBuilder.ts`, `processValueAccess`, the `case "index"` at
line ~1116:

```ts
// before
result = ts.index(result, this.processNode(element.index), {
  optional: element.optional,
});

// after
result = ts.call(ts.id("__nn"), [
  ts.index(result, this.processNode(element.index), {
    optional: element.optional,
  }),
]);
```

Because object subscript `obj[key]` and array subscript `arr[i]` parse to the same
`{ kind: "index" }` access-chain element and compile through this one branch, both the
missing-key and out-of-bounds cases are fixed together.

Intermediate steps in a longer chain are wrapped too — `obj[a][b]` becomes
`__nn(__nn(obj[a])[b])`. This is harmless: if `obj[a]` is missing, `__nn` yields `null`
and the subsequent `[b]` throws exactly as it would have thrown on `undefined`, only
with a `null`-worded message. The optional form `obj?.[key]` is likewise wrapped, so a
short-circuited optional index also normalizes to `null`.

**Explicitly untouched:** the index in an assignment LHS chain
(`lib/backends/typescriptBuilder/assignmentEmitter.ts:104`, `arr[i] = x`) is a write
target, not a value read, and stays raw.

### Fix 2 — `match` with no matching arm (companion)

The exploration found three distinct paths that can produce `undefined` from a `match`
expression, but they all funnel through a single **read** chokepoint: the
`isMatchValName` branch in `typescriptBuilder.ts` (~line 1034) that resolves a
`__matchval_<id>` reference to the frame-local where `runner.exitMatch` stored the arm
value. Coercing there covers every path at once:

```ts
// before
if (!isBuiltinVar && !isLoopVar && isMatchValName(literal.value)) {
  return ts.scopedVar(literal.value, "local", this.moduleId);
}

// after
if (!isBuiltinVar && !isLoopVar && isMatchValName(literal.value)) {
  return ts.call(ts.id("__nn"), [
    ts.scopedVar(literal.value, "local", this.moduleId),
  ]);
}
```

This single site handles:

- the stepped match expression whose temp is never written because no arm matched;
- the plain-mode (handler-body) expression match whose async IIFE returns `undefined`
  when no branch matched, then stores that into the same temp;
- the ordinary resolved read of a matched value (unchanged behavior — a real value
  passes through `__nn` untouched; a matched `null` stays `null`).

Additionally, change the valueless-`yield` emission at `typescriptBuilder.ts:1519` from
`ts.id("undefined")` to `ts.id("null")`, so an explicit bare `yield` reads `null` at the
source rather than relying only on the read-site coercion.

This is a runtime safety net. A well-typed match is either exhaustive (no fallthrough
possible) or carries a `_` arm (always matches); the no-arm-yields-`undefined` case only
arises when `matchExhaustiveness` is set to `warn`/`off`. The fix ensures that even then,
the leaked value is `null`.

## Testing

Agency execution tests (`tests/agency/`, `tests/agency-js/`) — no LLM calls required.

The subtlety: `__eq` makes `null == undefined`, so the difference cannot be observed with
Agency `==`. Tests must inspect the raw value another way:

- **agency-js test** asserting the returned value is strictly `=== null` in JS. This is
  the definitive check and the primary test vehicle.
- **JSON-shape** cross-check where useful: `{ a: null }` survives `JSON.stringify` as
  `{"a":null}`, whereas an `undefined`-valued key vanishes.

Cases to cover:

1. Object literal indexed by a key that is absent → `null`.
2. Array indexed out of bounds (index ≥ length, and negative) → `null`.
3. A present key / in-bounds index returns its real value unchanged (including
   falsy values `0`, `""`, `false` — these must NOT be coerced to `null`).
4. A non-exhaustive `match` expression with no `_` arm, evaluated with
   `matchExhaustiveness: "warn"` so codegen runs, whose scrutinee matches no arm → the
   match result is `null`.
5. A `match` arm that genuinely yields `null` still yields `null` (no double-coercion
   surprise), and an arm yielding a real value returns it unchanged.

Add a `lib/runtime/nn.test.ts` unit test for `__nn` itself mirroring `eq.test.ts`:
`undefined → null`, `null → null`, and the falsy values `0`/`""`/`false`/`NaN` pass
through unchanged.

## Files touched

- `lib/runtime/nn.ts` (new) — the helper.
- `lib/runtime/nn.test.ts` (new) — unit test.
- `lib/runtime/index.ts` — export `__nn`.
- `lib/templates/backends/typescriptGenerator/imports.ts` — add `__nn` to the emitted
  import list.
- `lib/backends/typescriptBuilder.ts` — wrap `case "index"` (~1116); wrap the
  `isMatchValName` read (~1034); change valueless-yield `undefined`→`null` (~1519).
- New execution/agency-js tests under `tests/`.
- `docs/dev/null-and-undefined.md` — note that index and match value sites are now
  normalized (updating the "known and unfixed" leak list).

## Fixture / build note

`__nn` newly appears in generated code, so integration fixtures under
`tests/typescriptGenerator/` (and any golden output) that exercise indexing or `match`
will shift. Rebuild fixtures with `make fixtures` and review the diff — the only expected
change is index/match expressions gaining a `__nn(...)` wrapper.
