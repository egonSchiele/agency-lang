# Durable Object Tags — Design

**Date:** 2026-07-07
**Status:** Design (approved in brainstorm; pending written-spec review)
**Follow-up to:** `2026-07-07-value-tags-and-redaction-design.md` (PR #447, merged)

## Summary

Make **object and array tags durable** — so a tag set with `std::tag`'s
`tag`/`redact` survives `fork`/`race`/`parallel` branches and interrupt/resume,
the same way primitive (value-keyed) tags already do.

Today object tags are **branch-local**: they live in a `WeakMap` keyed by object
identity, and both `fork` cloning and interrupt serialization round-trip state
through JSON, which destroys object identity — so the tag is lost. This is the
one limitation the base feature deferred (PR #447 review decision).

The fix: store a plain object's / array's tags **on the object itself** (a hidden
`Symbol` property) and teach Agency's single shared serialization chokepoint to
preserve it via one new reviver. Frozen and native-typed objects, which can't
carry a durable hidden property, keep the existing branch-local `WeakMap`.

## Goals

- Object/array tags survive `fork`/`race`/`parallel` and interrupt/resume for
  the common case (plain objects and arrays).
- `redact(obj)` keeps redacting that object in statelog after those boundaries.
- No regression for the cases that can't be made durable (frozen/native-typed
  objects) — they stay exactly as branch-local as they are today.
- Reuse the existing reviver machinery rather than inventing a parallel path.

## Non-goals

- **Primitive storage is unchanged.** Primitives stay value-keyed in the
  `Map` under `__internal` (already durable).
- **Durable tags for frozen or native-typed objects.** `Object.freeze`d objects
  and `Date`/`Map`/`Set`/`URL`/`RegExp`/`Error`/class instances keep the
  branch-local `WeakMap`. (Realistic tag targets are plain objects/arrays.)
- **Substring redaction, provenance, boxing.** Out of scope, as before.

## Background: why this needs the shared serializer

Object tags are usually on **locals**, not globals:

```ts
const userData = getUserData(userId)   // a local
redact(userData)
```

Agency copies/serializes state through **one shared chokepoint** —
`nativeTypeReplacer` / `nativeTypeReviver` (`lib/runtime/revivers/index.ts`) —
used by:

- `deepClone()` (`lib/runtime/utils.ts`) = `JSON.parse(JSON.stringify(obj,
  nativeTypeReplacer), nativeTypeReviver)`
- state-stack locals serialization (interrupt/resume) — via `deepClone`
- `GlobalStore.toJSON`/`fromJSON` (globals + fork clone)

Every one of these destroys object identity. A `WeakMap` keyed by identity
therefore can't follow an object through them — no matter where the object
lives. So durability has to be handled **at the shared reviver**, and the tag
has to ride **on the object** (the only thing that travels through every copy
path). This is why the "store tags on the object" direction is the right one,
and why patching only `GlobalStore` would be insufficient.

The reviver system is designed for exactly this: `Date`, `Map`, `Set`, `URL`,
`Error`, `RegExp`, and function refs already round-trip via pluggable revivers
that emit `{ __nativeType: "..." }` markers. Durable tags become **one more
reviver**.

## Design

### Storage dispatch

`GlobalStore.setTag` / `getTagsFor` / `removeTag` / `removeAllTags` dispatch on
the value:

| Value kind | Storage | Durable? |
|---|---|---|
| Primitive (`string`/`number`/`boolean`) | value `Map` under `__internal` | Yes (unchanged) |
| Plain object / array, extensible | non-enumerable `Symbol` prop **on the object** | **Yes (new)** |
| Frozen/sealed, native-typed, or other non-plain object | branch-local `WeakMap` | No (branch-local, unchanged) |

"Plain object" = `Object.getPrototypeOf(x) === Object.prototype` or `=== null`;
"array" = `Array.isArray(x)`. "Extensible" = `Object.isExtensible(x)` (a frozen
or sealed object is not).

**Dispatch order matters for freeze-after-tag.** The unified `tagsRecordFor`
helper must first check for an **existing** tag — `readTag(value)` (durable
symbol), then the `WeakMap` — and only consult `canHoldDurableTag` when
*creating* a new record. Otherwise an object tagged while extensible and then
`Object.freeze`d would report `canHoldDurableTag === false` and its on-object tag
would become unreachable (`getTagsFor` would miss it, `removeAllTags` would look
in the wrong store). Read/remove follow the tag that's actually there;
capability decides only where a *fresh* tag lands.

Helper (conceptual):

```ts
private canHoldDurableTag(value: unknown): boolean {
  if (!this.isRef(value)) return false;
  if (!Object.isExtensible(value)) return false;       // frozen/sealed → WeakMap
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;  // plain object
}
```

### The hidden tag property

```ts
const TAG_SYMBOL = Symbol("agencyTags");   // module-private, in globalStore.ts
```

Stored non-enumerable:

```ts
Object.defineProperty(obj, TAG_SYMBOL, {
  value: tags,          // Record<string, unknown>, null-prototype (as today)
  enumerable: false,
  writable: true,
  configurable: true,
});
```

A non-enumerable **Symbol** key is invisible to:

- `Object.keys`, `Object.getOwnPropertyNames`, `for…in`
- object spread `{...obj}` and `Object.assign` (they copy own *enumerable*
  props; a non-enumerable symbol is skipped) — so a spread copy is correctly
  **untagged** (new identity ⇒ new object)
- `JSON.stringify` (symbol-keyed properties are always dropped) — so it never
  leaks into logs or user-facing serialization

It's reachable only via `TAG_SYMBOL`, which only `globalStore.ts` holds.

### The `TaggedReviver`

A new reviver in `lib/runtime/revivers/`, registered in the shared array in
`index.ts` (order is irrelevant — plain objects/arrays match no other reviver):

```ts
class TaggedReviver implements BaseReviver<object> {
  nativeTypeName() { return "Tagged"; }

  isInstance(value: unknown): value is object {
    // Cheap: symbol lookup first, then confirm plain object/array.
    return (
      value != null &&
      (value as any)[TAG_SYMBOL] !== undefined &&
      isPlainObjectOrArray(value)
    );
  }

  serialize(value: object) {
    // {...value} / [...value] drops the non-enumerable symbol, so `v` is
    // tag-free and recursing into it will not re-match this reviver (no loop).
    // Nested natives and nested tagged values inside `v` recurse normally.
    const v = Array.isArray(value) ? [...value] : { ...value };
    return { __nativeType: "Tagged", tags: (value as any)[TAG_SYMBOL], v };
  }

  validate(value: Record<string, unknown>): boolean {
    return "tags" in value && "v" in value;
  }

  revive(value: Record<string, unknown>): object {
    // `v` is already revived (bottom-up). Re-attach the hidden tag.
    const target = value.v as object;
    // JSON.parse produced an Object.prototype-based tags record; restore the
    // null prototype so a later setTag(obj, "__proto__", ...) stays a plain data
    // property instead of assigning through the __proto__ setter (the same
    // invariant tagsRecordFor establishes on creation, globalStore.ts:62-64).
    Object.setPrototypeOf(value.tags as object, null);
    Object.defineProperty(target, TAG_SYMBOL, {
      value: value.tags,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return target;
  }
}
```

> Related residual (out of scope, noted for tracking): primitive tag records
> also come back `Object.prototype`-based after a `Map` round-trip via
> `MapReviver`. Same low-severity `__proto__`-key nuance; not fixed here since it
> predates this spec and `MapReviver` is generic (not tag-aware).

`TAG_SYMBOL` must be shared between `globalStore.ts` and `taggedReviver.ts`.
Export it from a small shared module (e.g. `globalStore.ts` exports it, or a tiny
`tagSymbol.ts` both import) to avoid a cycle.

### Serialization paths stay cleanly separated

- **State path** (`nativeTypeReplacer`/reviver, used by `deepClone` / globals /
  state stack): now preserves tags via `TaggedReviver`. It does **not** redact —
  state must keep real values.
- **Log path** (`statelogClient.post`): uses its own `makeRedactReplacer` + plain
  `JSON.stringify`, and never the Tagged reviver. So a `__nativeType:"Tagged"`
  marker can never appear in a log, and the hidden symbol tag is dropped from log
  output automatically. `isRedacted(obj)` reads the symbol to make the redaction
  decision.

`isRedacted(obj)` for a durably-tagged object is now a direct property read
(`obj[TAG_SYMBOL]?.redact === true`); for frozen/native objects it reads the
`WeakMap`; for primitives it reads the value `Map`. All three stay behind the
existing `GlobalStore.isRedacted` so callers are unchanged.

### The `hasAnyTags()` correctness fix (two flags + join propagation)

`statelogClient.post` gates the redaction pass on `GlobalStore.hasAnyTags()` to
keep tag-free programs cheap. Tags set on objects are **decentralized** — they
live on the object, not in a central store — so `hasAnyTags()` needs a signal
that tracks their presence across branch boundaries in **both** directions. The
two object storage paths have *different* propagation needs, so they get
**two different flags**:

**1. WeakMap path (frozen/native objects): in-memory flag, no propagation.**
Keep today's non-serialized `objectTagsPresent` boolean (`globalStore.ts:23`),
set on the WeakMap path. WeakMap tags are branch-local — they don't survive a
clone (the WeakMap isn't serialized) and don't cross a join (the branch's WeakMap
is discarded, and the returned object has no entry in the parent's WeakMap). So
their signal *correctly* resets on clone and is never propagated: there's no tag
on the other side to redact, so there's nothing to signal. Serializing this bit
would be wrong (claim a tag that doesn't exist) as well as a permanent
over-approximation.

**2. Durable path (symbol on plain object/array): serialized flag, propagated
both directions.** Add a **serializable, monotonic** flag in `__internal`
(`__hasDurableObjectTags: true`), set on the durable path.

- **Parent → child** (fork clone, `fromJSON` on resume): the flag lives in the
  serialized store, so it rides the round-trip. A branch/resumed run that
  inherited a durably-tagged object sees `hasAnyTags() === true`.
- **Child → parent** (join): a successful branch returns its value **by
  reference** (`runBatch.ts:381` — `return value`, no round-trip), so a branch
  that `redact`s an object and returns it hands the parent an object with its
  symbol tag intact — but the branch set the flag on its *cloned* store, which is
  discarded at join. Without propagation, the parent's flag stays false and it
  logs the object **unredacted** (a leak relative to the "survives fork" contract
  this spec introduces). **Fix:** at branch settle in `runBatch`, OR the branch
  store's `__hasDurableObjectTags` into the parent's store. It's a monotonic
  boolean, so this is a single idempotent write, and it mirrors the existing
  cost/token join propagation (`propagateBranchCost` / `propagateLoserCost` /
  `propagateWinnerCost` in `runBatch.ts`). Propagate on **both** the value-return
  and interrupt-settle paths (an interrupt payload `e.data` can reference a
  branch-tagged object handled by a parent handler — same hole). `shareGlobals:
  true` needs nothing (same store object).

**Combined check:**

```ts
hasAnyTags(): boolean {
  return (
    this.objectTagsPresent ||                                  // WeakMap path (in-memory)
    valueMapSize > 0 ||                                        // primitives (exact)
    this.get(INTERNAL_MODULE, "__hasDurableObjectTags") === true  // durable objects (serialized + join-propagated)
  );
}
```

Monotonic on the durable flag (never reset by `removeTag`/`removeAllTags`): it
may only **over**-approximate (an unnecessary redaction pass), never
**under**-approximate (a leak) — the safe direction for a redaction gate.
Primitives keep their exact `Map`-size check.

> The durable flag is set on the branch-local `GlobalStore` (the one
> `getRuntimeContext().globals` / `__globals()` resolves to), so it is per-branch
> and serialized with that branch's state; the join hook carries it up.

### Semantics changes (to document in the guide)

- Plain-object / array tags now **survive `fork`/`race`/`parallel` and
  interrupt/resume**. This is the headline change; the guide's current
  "object/array tags are branch-local" note is narrowed to *frozen and
  native-typed objects only*.
- A spread / structural copy (`{...obj}`) yields an **untagged** object —
  durability is about the *same* object traveling through Agency's own
  copy/serialize machinery, not about propagating to copies.

## Edge cases

- **Frozen/sealed object** → `canHoldDurableTag` is false → `WeakMap` (branch-
  local). No throw.
- **Native-typed object** (`Date`, `Map`, …) → non-plain → `WeakMap`. (Also
  sidesteps reviver-ordering between "Tagged" and the type's own reviver.)
- **Object frozen *after* tagging** → the symbol prop is already attached; the
  reviver only needs to *read* it on serialize and *define* it on a
  freshly-revived (not-yet-frozen) `v`, so serialize/read are unaffected.
  - **But `removeAllTags` must not `delete` the property.** Freezing makes the
    symbol prop non-configurable, so `delete obj[TAG_SYMBOL]` throws a
    `TypeError` in strict mode (all ESM). Implement `removeAllTags` on the
    durable path by **clearing the record's own keys** (the record object the
    symbol points to is separate and never frozen by `Object.freeze(target)`),
    not by deleting the property. This also keeps `setTag`/`removeTag` working on
    a frozen-after-tag object — they mutate the record, which is allowed
    (non-writable blocks *reassigning* the property, not mutating the object it
    references). `getTagsFor` then returns an empty record; the durable flag
    stays set (monotonic).
- **`__nativeType` collision** — a user plain object literally containing a
  `__nativeType` key is a pre-existing whole-codebase concern (all revivers share
  it), not introduced here.
- **Circular tagged object** — `JSON.stringify` already throws on cycles; no new
  behavior.
- **Tag values that are themselves native** (`tag(x, "when", someDate)`) — the
  `tags` record recurses through the normal replacer, so the `Date` round-trips
  via `DateReviver`. Works.

## Testing

Agency execution + agency-js tests need no LLM calls (per `docs/misc/TESTING.md`).

**Unit — `TaggedReviver` / `deepClone`:**
- `deepClone` of a tagged plain object preserves the tag (new identity, tag
  present); of a tagged array likewise.
- Nested: a tagged object inside another object round-trips.
- Spread `{...tagged}` produces an object with **no** tag.
- A tagged object whose tag value is a `Date` round-trips both.

**Unit — `GlobalStore` dispatch:**
- Plain object → tag stored on the object (survives `deepClone`/`clone`).
- Frozen object and a `Date` → tag stored in `WeakMap` (does **not** survive
  `clone`) — pins the documented fallback.
- `hasAnyTags()` stays `true` after `clone()`/`fromJSON` when a **durably**-tagged
  object was inherited (parent→child leak-guard); and is **not** falsely set by a
  WeakMap-only tag surviving a clone (the WeakMap flag resets).
- `removeTag` clears one key; `removeAllTags` empties the record.
- **`removeAllTags` on a tagged-then-**`Object.freeze`**d object does not throw**
  and leaves `getTagsFor` returning `{}` (Finding 2).
- After `deepClone`, `setTag(obj, "__proto__", …)` on the revived object stays a
  plain data property and does not pollute `Object.prototype` (Finding 3 —
  null-proto record restored on revive).

**Unit / integration — child→parent join (Finding 1):**
- A branch `redact`s a plain object and returns it; the **parent** then posts a
  statelog event containing it → `[REDACTED]` (the join-propagation guard). Fails
  today without the `runBatch` flag OR-in.

**Integration — statelog (`lib/statelogClient.redaction.test.ts`):**
- A `redact`ed object still logs `[REDACTED]` **after a fork-style globals
  clone** (the durability the follow-up exists for) — contrast the base PR's
  test where object tags were branch-local.
- Same after a `toJSON`/`fromJSON` round-trip (interrupt/resume analogue).

**Execution (`tests/agency/`):**
- A `fork` branch reads an inherited **object** tag (mirrors the existing
  `forkInheritsPrimitiveTag`, now for objects).
- Object-tag durability across a checkpoint/restore if cheaply expressible.

## Implementation surface (file map)

- `lib/runtime/revivers/taggedReviver.ts` — new `TaggedReviver` (+ unit test).
- `lib/runtime/revivers/index.ts` — register it in the `revivers` array.
- `lib/runtime/state/globalStore.ts` — `TAG_SYMBOL` (exported for the reviver);
  extend the **unified `tagsRecordFor` helper** (`globalStore.ts:65`) with the
  durable-vs-WeakMap dispatch so `setTag`/`getTagsFor`/`removeTag` all inherit it
  from one place; `removeAllTags` (`globalStore.ts:110`) is the one method with
  its own branch — update it to clear-record-keys on the durable path (never
  `delete`). **Keep** the in-memory `objectTagsPresent` (WeakMap path) and **add**
  the serialized `__hasDurableObjectTags` flag (durable path); update
  `hasAnyTags`/`isRedacted`. Keep the `WeakMap` as fallback.
- `lib/runtime/runBatch.ts` — at branch settle, OR the branch store's
  `__hasDurableObjectTags` into the parent's store (value-return and
  interrupt-settle paths), alongside the existing cost/token propagation.
- Tests: `globalStore.tags.test.ts` (extend), `redactForStatelog`/statelog
  integration (extend), `tests/agency/tag.agency` (extend), `taggedReviver.test.ts`
  (new).
- Docs: `docs/site/guide/tags.md` — narrow the branch-local caveat to
  frozen/native objects; note spread-drops-tag. Regenerate stdlib reference
  (`make`) — no signature changes expected.
- Spec: mark the "durable object tags" follow-up in the base design doc as
  addressed by this spec.

## Risks

- **Mutating user objects.** A hidden non-enumerable symbol is about as
  unobtrusive as possible, but it *is* a mutation. Documented; invisible to all
  standard reflection except `getOwnPropertySymbols`.
- **`isPlainObjectOrArray` misclassification.** If a genuinely plain object is
  misclassified as non-plain, it silently falls back to branch-local (no leak,
  just non-durable). The reverse (native object treated as plain) is prevented by
  the prototype check. Fail-safe direction.
- **Reviver runs on all state serialization.** `isInstance` adds one symbol
  lookup per object during state (de)serialization; negligible, and gated by the
  cheap symbol check before the prototype test.
