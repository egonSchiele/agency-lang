# Durable Object Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `std::tag` tags on plain objects/arrays survive `fork`/`race`/`parallel` and interrupt/resume (today they're branch-local), by storing them on the object itself and preserving them through Agency's shared serialization.

**Architecture:** A plain object's/array's tags move from a branch-local `WeakMap` onto the object as a non-enumerable `Symbol` property. One new reviver (`TaggedReviver`) in the shared `nativeTypeReplacer`/`nativeTypeReviver` array preserves that property across every state round-trip (`deepClone`, state stack, `GlobalStore` clone/serialize). Frozen and native-typed objects keep the `WeakMap` fallback. The redaction fast-path gate gains a serialized, join-propagated flag so a branch that tags an object doesn't leak it when the object returns to the parent.

**Tech Stack:** TypeScript, Agency stdlib, Vitest, Agency execution tests (`tests/agency/`), agency-js fixtures (`tests/agency-js/`).

**Design spec:** `docs/superpowers/specs/2026-07-07-durable-object-tags-design.md`
**Base feature (merged):** `docs/superpowers/specs/2026-07-07-value-tags-and-redaction-design.md` (PR #447)
**Spec review folded in:** `docs/superpowers/specs/2026-07-07-durable-object-tags-design-review.md` (Findings 1–3 + split-flag/naming suggestions).
**Plan review folded in:** `docs/superpowers/plans/2026-07-07-durable-object-tags-review.md` (Findings A–D + trailer/wording/final-verification notes).

## Global Constraints

- **Commit per task; push and open a PR at the end** (this work targets a PR, like the base feature). Branch off updated `main` in a fresh worktree. End commit messages with the **executing model's** `Co-Authored-By` trailer (e.g. `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` — don't copy a stale model name from an older plan); write messages/PR body via files (apostrophes on the CLI break).
- **Primitive tag storage is unchanged** — value `Map` under `__internal`.
- **Two object storage paths:** plain+extensible object/array → on-object Symbol (durable); frozen/sealed/native-typed/other → branch-local `WeakMap` (unchanged).
- **Read/remove locate an existing tag first; capability decides only where a *new* tag lands** (freeze-after-tag correctness).
- **`removeAllTags` on the durable path clears the record's keys — never `delete`s the property** (a frozen-after-tag property is non-configurable and `delete` throws).
- **Two presence flags:** in-memory `objectTagsPresent` (WeakMap path, resets on clone) + serialized `__hasDurableObjectTags` (durable path; parent→child via serialization, child→parent via a `runBatch` join OR-in). The durable flag is **monotonic** (never reset) and must be **locally true**: any store that *writes* to a durable record — including one created by another store, on an object that arrived by reference — sets its own flag, so the redaction gate never depends on propagation ordering.
- **The redaction log path is untouched** — `statelogClient` uses its own `makeRedactReplacer` + plain `JSON.stringify`, never the Tagged reviver. Symbol keys are dropped by `JSON.stringify`, so tags never leak into logs.
- **No import cycle:** the shared symbol/helpers live in a standalone `lib/runtime/state/tagSymbol.ts` imported by both `globalStore.ts` and `taggedReviver.ts` (never reviver→globalStore).
- **Rebuild after stdlib/reviver changes:** `make` before any compiled-CLI or fixture test. Vitest runs against TS source and needs no build.

---

### Task 1: `tagSymbol.ts` — shared symbol + object helpers

The dependency-free module holding the tag Symbol and the object-tag primitives, so `globalStore.ts` and the reviver share them without a cycle.

**Files:**
- Create: `lib/runtime/state/tagSymbol.ts`
- Test: `lib/runtime/state/tagSymbol.test.ts` (create)

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `TAG_SYMBOL: unique symbol`
  - `isPlainObjectOrArray(value: unknown): boolean`
  - `canHoldDurableTag(value: unknown): boolean`
  - `attachTag(target: object, tags: Record<string, unknown>): void`
  - `readTag(value: unknown): Record<string, unknown> | undefined`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/state/tagSymbol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  TAG_SYMBOL,
  isPlainObjectOrArray,
  canHoldDurableTag,
  attachTag,
  readTag,
} from "./tagSymbol.js";

describe("tagSymbol", () => {
  it("isPlainObjectOrArray: plain objects and arrays only", () => {
    expect(isPlainObjectOrArray({})).toBe(true);
    expect(isPlainObjectOrArray(Object.create(null))).toBe(true);
    expect(isPlainObjectOrArray([1, 2])).toBe(true);
    expect(isPlainObjectOrArray(new Date())).toBe(false);
    expect(isPlainObjectOrArray(new Map())).toBe(false);
    expect(isPlainObjectOrArray("s")).toBe(false);
    expect(isPlainObjectOrArray(null)).toBe(false);
  });

  it("canHoldDurableTag: plain/array AND extensible", () => {
    expect(canHoldDurableTag({})).toBe(true);
    expect(canHoldDurableTag([])).toBe(true);
    expect(canHoldDurableTag(Object.freeze({}))).toBe(false);
    expect(canHoldDurableTag(new Date())).toBe(false);
    expect(canHoldDurableTag(42)).toBe(false);
  });

  it("attachTag stores a non-enumerable, spread-invisible, null-proto record", () => {
    const o: Record<string, unknown> = { a: 1 };
    attachTag(o, Object.assign(Object.create(null), { redact: true }));
    expect(readTag(o)).toEqual({ redact: true });
    // Invisible to enumeration/spread/JSON:
    expect(Object.keys(o)).toEqual(["a"]);
    expect({ ...o }).toEqual({ a: 1 });
    expect(readTag({ ...o })).toBeUndefined();
    expect(JSON.stringify(o)).toBe('{"a":1}');
  });

  it("attachTag forces a null prototype on the record (proto-safety)", () => {
    const o = {};
    attachTag(o, { __proto__: { polluted: true } } as Record<string, unknown>);
    // The record must be null-proto so a "__proto__" key is plain data.
    const rec = readTag(o)!;
    expect(Object.getPrototypeOf(rec)).toBeNull();
  });

  it("readTag returns undefined for untagged / non-object values", () => {
    expect(readTag({})).toBeUndefined();
    expect(readTag("s")).toBeUndefined();
    expect(readTag(null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/state/tagSymbol.test.ts`
Expected: FAIL — cannot find module `./tagSymbol.js`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/runtime/state/tagSymbol.ts`:

```ts
// Module-private key for durable object tags. Stored non-enumerable, so it is
// invisible to Object.keys / for-in / spread / JSON.stringify (symbol keys are
// always dropped by JSON). Reachable only via this symbol.
export const TAG_SYMBOL: unique symbol = Symbol("agencyTags");

export function isPlainObjectOrArray(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// A value can hold a *durable* on-object tag only if it's a plain object/array
// and still extensible (a frozen/sealed object can't take a new property).
export function canHoldDurableTag(value: unknown): boolean {
  return isPlainObjectOrArray(value) && Object.isExtensible(value as object);
}

// Attach the tag record as a non-enumerable Symbol property. Forces the record
// null-proto so a user/LLM-controlled "__proto__" tag key is plain data (the
// same invariant GlobalStore establishes on creation and must restore on revive).
export function attachTag(
  target: object,
  tags: Record<string, unknown>,
): void {
  Object.setPrototypeOf(tags, null);
  Object.defineProperty(target, TAG_SYMBOL, {
    value: tags,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

export function readTag(value: unknown): Record<string, unknown> | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  return (value as Record<symbol, Record<string, unknown> | undefined>)[TAG_SYMBOL];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/state/tagSymbol.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/state/tagSymbol.ts lib/runtime/state/tagSymbol.test.ts
git commit -F <message-file>   # "feat(runtime): add tagSymbol module for durable object tags"
```

---

### Task 2: `TaggedReviver` — preserve on-object tags across serialization

The reviver that makes on-object tags survive `deepClone` / state-stack / `GlobalStore` round-trips.

**Files:**
- Create: `lib/runtime/revivers/taggedReviver.ts`
- Modify: `lib/runtime/revivers/index.ts` (register in the `revivers` array)
- Test: `lib/runtime/revivers/taggedReviver.test.ts` (create)

**Interfaces:**
- Consumes: `TAG_SYMBOL`, `isPlainObjectOrArray`, `attachTag`, `readTag` (Task 1); `BaseReviver`; `deepClone` (`lib/runtime/utils.ts`) for the test.
- Produces: `TaggedReviver` class registered in the shared reviver array (nativeType name `"Tagged"`).

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/revivers/taggedReviver.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deepClone } from "../utils.js";
import { attachTag, readTag } from "../state/tagSymbol.js";

function tagged<T extends object>(obj: T, tags: Record<string, unknown>): T {
  attachTag(obj, Object.assign(Object.create(null), tags));
  return obj;
}

describe("TaggedReviver (via deepClone)", () => {
  it("preserves a plain object's tag across deepClone (new identity, tag intact)", () => {
    const obj = tagged({ a: 1 }, { redact: true });
    const cloned = deepClone(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned).toEqual({ a: 1 });
    expect(readTag(cloned)).toEqual({ redact: true });
  });

  it("preserves an array's tag across deepClone", () => {
    const arr = tagged([1, 2, 3], { redact: true });
    const cloned = deepClone(arr);
    expect(cloned).toEqual([1, 2, 3]);
    expect(readTag(cloned)).toEqual({ redact: true });
  });

  it("preserves a nested tagged object", () => {
    const inner = tagged({ secret: "s" }, { redact: true });
    const cloned = deepClone({ outer: { inner } }) as any;
    expect(readTag(cloned.outer.inner)).toEqual({ redact: true });
  });

  it("restores a null-prototype tag record on revive (proto-safety)", () => {
    const cloned = deepClone(tagged({ a: 1 }, { x: 1 }));
    expect(Object.getPrototypeOf(readTag(cloned)!)).toBeNull();
  });

  it("a spread copy is untagged (reference semantics)", () => {
    const obj = tagged({ a: 1 }, { redact: true });
    expect(readTag({ ...obj })).toBeUndefined();
  });

  it("round-trips a tag whose value is itself a native type (Date)", () => {
    const when = new Date("2026-01-01T00:00:00.000Z");
    const cloned = deepClone(tagged({ a: 1 }, { when }));
    expect(readTag(cloned)!.when).toBeInstanceOf(Date);
    expect((readTag(cloned)!.when as Date).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/revivers/taggedReviver.test.ts`
Expected: FAIL — `readTag(cloned)` is `undefined` (deepClone drops the symbol; reviver not registered yet).

- [ ] **Step 3: Write minimal implementation**

Create `lib/runtime/revivers/taggedReviver.ts`:

```ts
import { BaseReviver } from "./baseReviver.js";
import { TAG_SYMBOL, isPlainObjectOrArray, attachTag, readTag } from "../state/tagSymbol.js";

// Preserves a plain object's / array's durable tag (a non-enumerable TAG_SYMBOL
// property) across the shared JSON round-trip. Plain objects/arrays match no
// other reviver, so registration order is irrelevant.
export class TaggedReviver implements BaseReviver<object> {
  nativeTypeName(): string {
    return "Tagged";
  }

  isInstance(value: unknown): value is object {
    // Cheap symbol read first, then confirm it's a plain object/array.
    return readTag(value) !== undefined && isPlainObjectOrArray(value);
  }

  serialize(value: object): Record<string, unknown> {
    // Spread drops the non-enumerable symbol, so `v` is tag-free and recursing
    // into it can't re-match this reviver (no loop). Nested natives and nested
    // tagged values inside `v` recurse normally.
    const v = Array.isArray(value) ? [...value] : { ...value };
    return { __nativeType: this.nativeTypeName(), tags: readTag(value), v };
  }

  validate(value: Record<string, unknown>): boolean {
    return "tags" in value && "v" in value;
  }

  revive(value: Record<string, unknown>): object {
    // `v` is already revived (bottom-up). attachTag re-hides the tag and
    // restores the null prototype the JSON round-trip stripped.
    const target = value.v as object;
    attachTag(target, value.tags as Record<string, unknown>);
    return target;
  }
}
```

In `lib/runtime/revivers/index.ts`, import and register it:

```ts
import { TaggedReviver } from "./taggedReviver.js";
```

Add `new TaggedReviver(),` to the `revivers` array (anywhere; order is irrelevant):

```ts
const revivers: BaseReviver<any>[] = [
  new SetReviver(),
  new MapReviver(),
  new DateReviver(),
  new RegExpReviver(),
  new URLReviver(),
  new ErrorReviver(),
  new TaggedReviver(),
  functionRefReviver,
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/revivers/taggedReviver.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the existing reviver + state suites (no regression)**

Run: `pnpm test:run lib/runtime/revivers lib/runtime/state`
Expected: PASS (existing reviver/state tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/revivers/taggedReviver.ts lib/runtime/revivers/index.ts lib/runtime/revivers/taggedReviver.test.ts
git commit -F <message-file>   # "feat(runtime): add TaggedReviver to preserve on-object tags across serialization"
```

---

### Task 3: `GlobalStore` durable dispatch + flags

Route plain-object/array tags to the on-object symbol, keep the WeakMap fallback, and add the serialized durable-presence flag.

**Files:**
- Modify: `lib/runtime/state/globalStore.ts`
- Test: `lib/runtime/state/globalStore.tags.test.ts` (extend)

**Interfaces:**
- Consumes: `canHoldDurableTag`, `attachTag`, `readTag` (Task 1).
- Produces (new/changed on `GlobalStore`):
  - `setDurableObjectTagFlag(): void`
  - `hasDurableObjectTagFlag(): boolean`
  - unchanged public shapes for `setTag`/`getTagsFor`/`removeTag`/`removeAllTags`/`isRedacted`/`hasAnyTags`.

- [ ] **Step 1: Write the failing test**

Add to `lib/runtime/state/globalStore.tags.test.ts`:

```ts
import { deepClone } from "../utils.js";
import { readTag } from "./tagSymbol.js";

describe("GlobalStore durable object tags", () => {
  it("stores a plain object's tag ON the object (survives deepClone)", () => {
    const gs = new GlobalStore();
    const o = { id: 1 };
    gs.setTag(o, "redact", true);
    expect(readTag(o)).toEqual({ redact: true });   // on the object
    const cloned = deepClone(o);
    expect(gs.getTagsFor(cloned)).toEqual({ redact: true });  // durable
  });

  it("frozen and native-typed objects fall back to the WeakMap (branch-local)", () => {
    const gs = new GlobalStore();
    const frozen = Object.freeze({ id: 1 });
    const date = new Date();
    gs.setTag(frozen, "redact", true);
    gs.setTag(date, "redact", true);
    expect(readTag(frozen)).toBeUndefined();   // not on the object
    expect(gs.getTagsFor(frozen)).toEqual({ redact: true });  // in WeakMap
    expect(gs.getTagsFor(date)).toEqual({ redact: true });
  });

  it("resolves a tag on an object frozen AFTER tagging (read/remove first)", () => {
    const gs = new GlobalStore();
    const o: Record<string, unknown> = { id: 1 };
    gs.setTag(o, "redact", true);   // durable path (extensible)
    Object.freeze(o);               // now non-extensible
    expect(gs.getTagsFor(o)).toEqual({ redact: true });   // still found
    gs.setTag(o, "extra", 1);       // mutates the record, no throw
    expect(gs.getTagsFor(o)).toEqual({ redact: true, extra: 1 });
    expect(() => gs.removeAllTags(o)).not.toThrow();       // clears keys, no delete
    // NOTE: intentional asymmetry — the durable path returns {} after
    // removeAllTags (keys cleared in place; the record can't be deleted off a
    // frozen target), while the WeakMap/primitive paths delete the entry and
    // return undefined. Don't "unify" this back to a delete: it throws on
    // frozen-after-tag objects. isRedacted (=== true) is unaffected.
    expect(gs.getTagsFor(o)).toEqual({});
  });

  it("adding a tag to an object tagged by ANOTHER store sets this store's durable flag", () => {
    // The durable record rides ON the object, so a store can adopt one it never
    // created (object arrived by reference, e.g. from a settled branch). A
    // write through this store must set ITS flag — the redaction gate has to be
    // locally true, not dependent on join-propagation ordering.
    const a = new GlobalStore();
    const b = new GlobalStore();
    const o = { id: 1 };
    a.setTag(o, "redact", true);          // record created via store A
    expect(b.hasDurableObjectTagFlag()).toBe(false);
    b.setTag(o, "extra", 1);              // store B adopts the existing record
    expect(b.hasDurableObjectTagFlag()).toBe(true);
  });

  it("durable flag survives clone/fromJSON (parent->child); WeakMap flag resets", () => {
    const gs = new GlobalStore();
    gs.setTag({ id: 1 }, "redact", true);            // durable
    expect(gs.hasDurableObjectTagFlag()).toBe(true);
    expect(gs.clone().hasDurableObjectTagFlag()).toBe(true);
    expect(GlobalStore.fromJSON(gs.toJSON()).hasAnyTags()).toBe(true);

    const weakOnly = new GlobalStore();
    weakOnly.setTag(Object.freeze({}), "redact", true);  // WeakMap path
    expect(weakOnly.hasAnyTags()).toBe(true);
    expect(weakOnly.clone().hasAnyTags()).toBe(false);   // WeakMap bit resets
  });

  it("setDurableObjectTagFlag is idempotent and readable", () => {
    const gs = new GlobalStore();
    expect(gs.hasDurableObjectTagFlag()).toBe(false);
    gs.setDurableObjectTagFlag();
    gs.setDurableObjectTagFlag();
    expect(gs.hasDurableObjectTagFlag()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/state/globalStore.tags.test.ts`
Expected: FAIL — `readTag(o)` undefined (object still WeakMap-stored) / `hasDurableObjectTagFlag` not a function.

- [ ] **Step 3: Write minimal implementation**

In `lib/runtime/state/globalStore.ts`, add the import:

```ts
import { canHoldDurableTag, attachTag, readTag } from "./tagSymbol.js";
```

Add the durable-flag key beside `VALUE_TAGS_KEY`:

```ts
  private static readonly DURABLE_FLAG_KEY = "__hasDurableObjectTags";
```

Replace the object branch of `tagsRecordFor` (currently the `if (this.isRef(value)) { … objectTags … }` block) with read-existing-first dispatch:

```ts
    if (this.isRef(value)) {
      // Follow an existing tag wherever it already lives (so an object frozen
      // AFTER tagging still resolves to its on-object record).
      const durable = readTag(value);
      if (durable !== undefined) {
        // The record may have been created by ANOTHER store (the object arrived
        // by reference, e.g. from a settled branch). On a write, set THIS
        // store's flag too — the redaction gate must be locally true, not
        // dependent on join-propagation ordering. Monotonic + idempotent.
        if (create) {
          this.set(GlobalStore.INTERNAL_MODULE, GlobalStore.DURABLE_FLAG_KEY, true);
        }
        return durable;
      }
      const weak = this.objectTags.get(value);
      if (weak !== undefined) return weak;
      if (!create) return undefined;
      // Creating: choose the path by current capability.
      const record = Object.create(null) as Record<string, unknown>;
      if (canHoldDurableTag(value)) {
        attachTag(value, record);
        this.set(GlobalStore.INTERNAL_MODULE, GlobalStore.DURABLE_FLAG_KEY, true);
      } else {
        this.objectTags.set(value, record);
        this.objectTagsPresent = true;
      }
      return record;
    }
```

Replace `removeAllTags` with a durable-aware version that never `delete`s the property:

```ts
  /** Remove every tag from a value. */
  removeAllTags(value: unknown): void {
    if (this.isRef(value)) {
      const durable = readTag(value);
      if (durable !== undefined) {
        // Clear keys in place — the record object is separate from the (possibly
        // frozen) target, and `delete target[TAG_SYMBOL]` would throw on a
        // frozen-after-tag object. Intentional asymmetry with the WeakMap/
        // primitive paths: getTagsFor afterwards returns {} here (record stays
        // attached, so the TaggedReviver keeps wrapping the object with empty
        // tags), undefined there. Harmless — isRedacted checks `=== true`.
        for (const key of Object.keys(durable)) delete durable[key];
        return;
      }
      this.objectTags.delete(value);
      return;
    }
    const map = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    if (map instanceof Map) map.delete(value);
  }
```

Update `hasAnyTags` to include the durable flag:

```ts
  hasAnyTags(): boolean {
    if (this.objectTagsPresent) return true;
    if (this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.DURABLE_FLAG_KEY) === true) {
      return true;
    }
    const map = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    return map instanceof Map && map.size > 0;
  }
```

Add the flag accessors (used by `runBatch` in Task 4):

```ts
  /** True when any durable (on-object) tag has been created on this store. */
  hasDurableObjectTagFlag(): boolean {
    return this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.DURABLE_FLAG_KEY) === true;
  }

  /** Set the durable-object-tag presence flag (monotonic; join-propagated). */
  setDurableObjectTagFlag(): void {
    this.set(GlobalStore.INTERNAL_MODULE, GlobalStore.DURABLE_FLAG_KEY, true);
  }
```

> `getTagsFor` / `setTag` / `removeTag` are unchanged — they already funnel through `tagsRecordFor`, which now does the durable dispatch. `isRedacted` is unchanged (reads `getTagsFor`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/state/globalStore.tags.test.ts`
Expected: PASS (existing base-feature tests + 6 new durable tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/state/globalStore.ts lib/runtime/state/globalStore.tags.test.ts
git commit -F <message-file>   # "feat(runtime): durable on-object tag dispatch + presence flag in GlobalStore"
```

---

### Task 4: `runBatch` child→parent flag propagation (Finding 1)

Close the leak where a branch tags an object, returns it by reference, and the parent's redaction gate is unset.

**Files:**
- Modify: `lib/runtime/runBatch.ts` (branch-settle point, ~line 381)
- Test: `lib/runtime/runBatch.test.ts` (extend) — mechanism; plus an agency-js fixture for the end-to-end guard.
- Create: `tests/agency-js/tag-fork-redaction/agent.agency`
- Create: `tests/agency-js/tag-fork-redaction/agency.json` (**required** — `statelog.log` only exists when the fixture enables file logging; see siblings `llm-call-single-span`/`fork-branch-value`)
- Create: `tests/agency-js/tag-fork-redaction/test.js`

**Interfaces:**
- Consumes: `GlobalStore.hasDurableObjectTagFlag` / `setDurableObjectTagFlag` (Task 3); the on-object durable tag (Tasks 1–3).
- Produces: parent store's durable flag is set whenever a settling branch had one. No new exported symbols.

- [ ] **Step 1: Write the failing mechanism test**

Add to `lib/runtime/runBatch.test.ts` a focused case. (Mirror the file's existing `makeParent`/`runBatch` harness; a branch body sets a durable tag via its branch-local globals, and after settle the parent store carries the flag.)

```ts
import { GlobalStore } from "./state/globalStore.js";

it("propagates the durable-object-tag flag from a settled branch to the parent", async () => {
  const { ctx } = makeCtx();
  const parentGlobals = new GlobalStore();
  ctx.globals = parentGlobals;

  // A branch that durably-tags an object it returns. In runBatch the branch
  // body runs against a cloned branchGlobals; here we assert the parent flag
  // is OR'd in after the branch settles.
  await runBatch(
    /* items/branches per the harness */ [{ /* branch that calls
       getRuntimeContext().globals.setTag({}, "redact", true) and returns it */ }] as any,
    { ctx, parent: { globals: parentGlobals } } as any,
  );

  expect(parentGlobals.hasDurableObjectTagFlag()).toBe(true);
});
```

> Implementation note for the executor: match the exact `runBatch` call
> signature used elsewhere in this test file (`makeParent()` +
> `runBatch(...)`). The assertion that matters is
> `parentGlobals.hasDurableObjectTagFlag() === true` after a branch that set its
> branch-local durable flag settles. If wiring a branch body that reaches
> branch-local globals via ALS is impractical in this stub, rely on the agency-js
> fixture below as the end-to-end guard and keep this as a direct check that
> `setDurableObjectTagFlag()` on a child store OR's into the parent through the
> settle hook.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/runBatch.test.ts`
Expected: FAIL — parent flag stays `false` (no propagation yet).

- [ ] **Step 3: Write minimal implementation**

In `lib/runtime/runBatch.ts`, wrap the branch body (the `const value = await fn();` … `return value;` block inside the `agencyStore.run` closure) in `try`/`finally`, with the propagation in the `finally`:

```ts
    async () => {
      try {
        // (existing body unchanged: await fn(), capture-on-INTERRUPT snapshot,
        // return value)
        const value = await fn();
        if (hasInterrupts(value)) {
          if (!shareGlobals) branch.globalsJSON = branchGlobals.toJSON();
          if (!shareThreads) branch.activeStack = [...branchThreads.activeStack];
        }
        return value;
      } finally {
        // Durable object tags set inside the branch travel back on the returned
        // value (by reference), but the branch's presence flag lives on its
        // discarded cloned store. OR it into the parent so the parent's statelog
        // redaction gate still fires. In a `finally` so value, interrupt, AND
        // throw settles all propagate — a thrown error can reference a
        // branch-tagged object that the parent catches and logs. (The snapshot
        // block above deliberately skips throws, but that logic is about resume
        // state; the monotonic flag has no reason to skip.) One idempotent
        // write. shareGlobals: true needs nothing (same store).
        if (!shareGlobals && branchGlobals.hasDurableObjectTagFlag()) {
          parent.globals.setDurableObjectTagFlag();
        }
      }
    },
```

- [ ] **Step 4: Run mechanism test**

Run: `pnpm test:run lib/runtime/runBatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the end-to-end agency-js fixture**

Create `tests/agency-js/tag-fork-redaction/agency.json` — without this, no
`statelog.log` is written and the test fails for the wrong reason (missing/empty
log, which looks like the redaction bug and invites weakening the assertions):

```json
{
  "observability": true,
  "log": {
    "logFile": "statelog.log"
  }
}
```

Create `tests/agency-js/tag-fork-redaction/agent.agency`:

```ts
import { redact } from "std::tag"

def tagInBranch(item: string): any {
  const secret = { apiKey: "sk-branch-secret" }
  redact(secret)
  return secret
}

node main(): any {
  // The branch durably tags an object and returns it by reference to the
  // parent. When the parent logs its node data, the object must be redacted —
  // which only happens if the durable-tag flag propagated to the parent.
  const results = fork(["only"]) as item {
    return tagInBranch(item)
  }
  return results
}
```

Create `tests/agency-js/tag-fork-redaction/test.js` (mirror the harness of a sibling in `tests/agency-js/fork/*`; the point is to run `main()` then inspect the fixture's `statelog.log`):

```js
import { main } from "./agent.js";
import { readFileSync, writeFileSync } from "fs";

const logPath = new URL("./statelog.log", import.meta.url);
writeFileSync(logPath, "");     // truncate any prior run's appended events

await main();

const log = readFileSync(logPath, "utf8");
if (log.includes("sk-branch-secret")) {
  throw new Error("LEAK: branch-tagged secret appeared in parent statelog (Finding 1)");
}
if (!log.includes("[REDACTED]")) {
  throw new Error("Expected [REDACTED] in statelog — object not redacted after fork join");
}
console.log("ok: branch-tagged object redacted in parent statelog");
```

- [ ] **Step 6: Build and run the fixture**

Run: `make` (rebuilds stdlib/reviver), then run the fixture through the repo's agency-js test runner — it compiles `agent.agency` → `agent.js` and executes `test.js` (do NOT invoke `node test.js` directly; `agent.js` won't exist). Capture output to a file per repo convention:

```bash
make 2>&1 | tail -3
pnpm run agency test js tests/agency-js/tag-fork-redaction/test.js 2>&1 | tee /tmp/tag-fork.out
```

Expected: prints `ok: branch-tagged object redacted in parent statelog` (no LEAK/throw).

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/runBatch.ts lib/runtime/runBatch.test.ts tests/agency-js/tag-fork-redaction/
git commit -F <message-file>   # "fix(runtime): propagate durable object-tag flag on branch join (no redaction leak)"
```

---

### Task 5: Statelog durability integration test

Prove a durably-tagged object is redacted in statelog *after* it has gone through the shared serialization (the reviver path), end to end at the TS layer.

**Files:**
- Test: `lib/statelogClient.redaction.test.ts` (extend)

**Interfaces:**
- Consumes: `deepClone` (`lib/runtime/utils.ts`), `GlobalStore` durable tags (Tasks 1–3), `runInTestContext`, `ctx.statelogClient.post`.
- Produces: none (test only).

- [ ] **Step 1: Write the failing test**

Add to `lib/statelogClient.redaction.test.ts` (reuse the file's `makeStdoutCtx` / `printed` helpers):

```ts
import { deepClone } from "./runtime/utils.js";

it("redacts a durably-tagged object after it survives serialization", async () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const ctx = makeStdoutCtx();
  const execCtx = await ctx.createExecutionContext("r1");
  await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
    const creds = { user: "alice", pass: "hunter2" };
    execCtx.globals.setTag(creds, "redact", true);     // durable (on-object)
    // Round-trip the object the way fork/interrupt do to state:
    const revived = deepClone(creds);
    expect(revived).not.toBe(creds);                   // new identity
    await execCtx.statelogClient.post({ event: "toolCall", args: { creds: revived } });
  });
  expect(printed(spy)).toContain("[REDACTED]");
  expect(printed(spy)).not.toContain("hunter2");
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `pnpm test:run lib/statelogClient.redaction.test.ts`
Expected: with Tasks 1–3 in place it PASSES; if run before them it FAILS (revived object loses its tag → `hunter2` leaks). Confirm it passes now.

- [ ] **Step 3: Run the full feature TS suite (no regression)**

Run: `pnpm test:run lib/runtime/state lib/runtime/revivers lib/runtime/redactForStatelog.test.ts lib/statelogClient.test.ts lib/statelogClient.redaction.test.ts lib/stdlib/tag.test.ts`
Expected: PASS across all.

- [ ] **Step 4: Commit**

```bash
git add lib/statelogClient.redaction.test.ts
git commit -F <message-file>   # "test(statelog): durable-tagged object redacts after serialization round-trip"
```

---

### Task 6: Docs + execution test + regenerate

Update the guide's semantics, add a compiled durability check, regenerate the stdlib reference, and cross-link the base spec.

**Files:**
- Modify: `docs/site/guide/tags.md`
- Modify: `docs/superpowers/specs/2026-07-07-value-tags-and-redaction-design.md` (mark follow-up addressed)
- Modify: `tests/agency/tag.agency` and `tests/agency/tag.test.json` (add object-tag fork-durability node)
- (Generated) `docs/site/stdlib/tag.md` via `make`

**Interfaces:**
- Consumes: the shipped durable-tag behavior (Tasks 1–4).
- Produces: docs + one execution test.

- [ ] **Step 1: Narrow the guide's branch-local caveat**

In `docs/site/guide/tags.md`, replace the current branch-local note:

```markdown
> Object and array tags are branch-local: they do not survive `fork`, `race`,
> or `parallel` branches, or an interrupt/resume. Primitive (value) tags
> survive both.
```

with:

```markdown
> Tags on **plain objects and arrays** survive `fork`, `race`, `parallel`,
> and interrupt/resume, the same as primitive (value) tags. A **spread or
> structural copy** (`{...obj}`) produces an *untagged* new object — durability
> follows the *same* object, not its copies. Tags on **frozen/sealed objects**
> and **native-typed objects** (`Date`, `Map`, `Set`, …) are branch-local
> (best-effort) — they can't carry the durable marker.
```

(Reference docs are timeless — no "now"/"new" phrasing.)

- [ ] **Step 2: Write the failing execution test**

Add to `tests/agency/tag.agency`:

```ts
node forkInheritsObjectTag(): boolean {
  // A plain object tagged in the parent is durable: the fork branch's clone of
  // it carries the tag. (Contrast primitives, already covered.)
  const o = { id: 1 }
  redact(o)
  const results = fork(["only"]) as item {
    return getTags(o)["redact"] == true
  }
  return results[0]
}
```

Add to `tests/agency/tag.test.json` (inside `"tests"`):

```json
    { "nodeName": "forkInheritsObjectTag", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] }
```

- [ ] **Step 3: Build and run docs regen + execution tests**

Run: `make 2>&1 | tail -3` (regenerates `docs/site/stdlib/tag.md`; no signature changes expected), then:

```bash
pnpm run a test tests/agency/tag.agency 2>&1 | tee /tmp/tag-exec.out
```

Expected: all nodes pass, including `forkInheritsObjectTag`.

- [ ] **Step 4: Cross-link the base spec**

In `docs/superpowers/specs/2026-07-07-value-tags-and-redaction-design.md`, update the "Durable object tags (custom serialization)" follow-up bullet to note it is addressed by `2026-07-07-durable-object-tags-design.md` (and this plan).

- [ ] **Step 5: Commit**

```bash
git add docs/site/guide/tags.md docs/site/stdlib/tag.md docs/superpowers/specs/2026-07-07-value-tags-and-redaction-design.md tests/agency/tag.agency tests/agency/tag.test.json
git commit -F <message-file>   # "docs: object tags are durable for plain objects/arrays; + fork-durability execution test"
```

---

### Task 7: Final verification + PR

Full-suite regression check, structural lint, then push and open the PR.

**Files:** none created/modified (verification + PR only).

- [ ] **Step 1: Run the full unit suite (output to a file — never rerun to see what failed)**

```bash
pnpm test:run 2>&1 | tee /tmp/durable-tags-full-suite.out
tail -20 /tmp/durable-tags-full-suite.out
```

Expected: PASS. If anything fails, read `/tmp/durable-tags-full-suite.out` — do not rerun the suite to see the failure again.

- [ ] **Step 2: Run the structural linter**

```bash
pnpm run lint:structure 2>&1 | tee /tmp/durable-tags-lint.out
```

Expected: clean.

> Do NOT run the full agency execution suite locally (repo rule — CI runs it on the PR). Only the specific agency/agency-js tests touched by Tasks 4 and 6 run locally.

- [ ] **Step 3: Push and open the PR**

Write the PR body to a file (apostrophes on the CLI break), then:

```bash
git push -u origin <branch>
gh pr create --title "Durable object tags: plain object/array tags survive fork and interrupt/resume" --body-file <body-file>
```

PR body should link the design spec, the spec review, and this plan; call out the two leak-guard mechanisms (locally-true flag on adopt-write + join OR-in in `finally`) so reviewers know both exist on purpose.

---

## Self-Review

**Spec coverage:**
- On-object Symbol storage + helpers → Task 1.
- `TaggedReviver` preserving tags through the shared round-trip → Task 2.
- Storage dispatch (plain→durable, frozen/native→WeakMap, read-existing-first) → Task 3.
- `removeAllTags` clears keys / never deletes (Finding 2) → Task 3 (impl + test).
- Null-prototype record restored on revive (Finding 3) → Task 1 (`attachTag`) + Task 2 (test).
- Two presence flags; parent→child serialization → Task 3; **child→parent join propagation (Finding 1)** → Task 4.
- Log-path separation (no leak, symbol dropped) → exercised in Tasks 4–5.
- Semantics + edge cases (spread untagged, freeze-after-tag) → Tasks 2, 3, 6.
- Docs + regenerate + base-spec cross-link → Task 6.
- Non-goals (primitives unchanged, no substring/provenance/boxing) → untouched.

**Plan-review coverage (Findings A–D):**
- **A** (fixture needs `agency.json` + run via `pnpm run agency test js`, not raw `node`) → Task 4 Steps 5–6 + file list.
- **B** (flag must be locally true when a store adopts an already-tagged object) → Task 3 dispatch sets the flag on the readTag-existing write path + dedicated two-store test; Global Constraints updated.
- **C** (propagation must survive branch throws) → Task 4 Step 3 moves the OR-in into a `finally` (value/interrupt/throw settles all propagate).
- **D** (durable `removeAllTags` → `getTagsFor` returns `{}`, not `undefined`) → intentional-asymmetry comments in Task 3's test and `removeAllTags` impl.
- Smaller notes: executing-model commit trailer (Global Constraints), timeless guide wording (Task 6), full unit suite + structural lint + PR → Task 7.

**Placeholder scan:** The only non-literal is Task 4 Step 1's `runBatch(...)` call, which must match this test file's existing `makeParent`/`runBatch` harness — flagged inline with the concrete assertion (`parentGlobals.hasDurableObjectTagFlag() === true`) and a fixture fallback. All other steps contain complete code.

**Type consistency:** `TAG_SYMBOL`/`attachTag`/`readTag`/`isPlainObjectOrArray`/`canHoldDurableTag` (Task 1) used identically in Tasks 2–3. `hasDurableObjectTagFlag`/`setDurableObjectTagFlag` defined in Task 3, consumed in Task 4. `TaggedReviver` nativeType `"Tagged"` consistent.

**Deferred (unchanged):** substring redaction; `pii`/other special tags; low-entropy dev-mode warning; provenance; the primitive-record null-proto-after-clone residual (noted in spec, out of scope).
