# Value Tags & Statelog Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Agency programs attach arbitrary tags to values (`tag`/`getTags`) and mark values for statelog redaction (`redact`), so secrets like API keys never appear in state logs.

**Architecture:** Two tag stores live on the existing per-branch `GlobalStore`: a value-keyed `Map` for primitives (durable — clones and serializes with globals) and a reference-keyed `WeakMap` for objects (branch-local — reset on clone). A new `std::tag` module exposes `tag`/`getTags`/`redact` over TS helpers that read the branch-local store via the `__globals()` ALS accessor. The `redact` semantics are owned entirely by `GlobalStore` (`markRedacted`/`isRedacted`/`REDACT_TAG`) so no other file hard-codes the tag's shape. Statelog redaction runs at a single chokepoint (`StatelogClient.post`) as a **`JSON.stringify` replacer scoped to the event's `data` payload** — the envelope and payload are stringified separately and spliced, so the replacer rides one serialization pass over `data` (no second traversal), inherits `JSON.stringify`'s native handling of `Date`/`URL`/etc., and can never touch infra fields like `format_version`/`trace_id` (tagged values are swapped for `"[REDACTED]"`; everything else is untouched).

**Tech Stack:** TypeScript, Agency stdlib (`.agency` + TS impl), Vitest (unit/integration), Agency execution tests (`tests/agency/`).

**Design spec:** `docs/superpowers/specs/2026-07-07-value-tags-and-redaction-design.md`

**Review folded in:** `docs/superpowers/plans/2026-07-07-value-tags-and-redaction-review.md` (walker→replacer rework, redact-tag encapsulation, `hasAnyTags` fast path, native-type + fork-durability + substring-boundary tests).

## Global Constraints

- **Do NOT `git commit` or `git push`.** Per user instruction, all work stays in the local working tree. Each task's completion gate is its passing test, not a commit.
- **No boxing of primitives.** Tags live only in side stores; values are never wrapped.
- **Two store semantics (must be documented):** primitives are keyed by **value** (all equal primitives share tags); objects/arrays by **reference** (structurally-equal distinct objects do not share tags).
- **Object tags are branch-local.** They do not survive `fork`/`parallel`/`race` cloning or interrupt/resume. Primitive tags survive both.
- **Redaction is a `JSON.stringify` replacer, not a pre-copy walk.** This is load-bearing: a replacer runs inside statelog's existing single stringify (no extra deep copy) and preserves `Date`/`URL` and other `toJSON`-bearing values — a naive `Object.entries` deep-walk flattens those to `{}`. The replacer recovers the raw pre-`toJSON` value via `this[key]`, mirroring the existing `nativeTypeReplacer`.
- **Redaction is scoped to the `data` payload, never the envelope.** The envelope (`format_version`, `trace_id`, `project_id`, span ids) and the payload are stringified separately and spliced, so a value-collision (e.g. a user tagging the number `1`, which equals `format_version`) can never corrupt an infra field. Worst case of a low-entropy tag is over-redaction *within* the user's own payload.
- **v1 redaction is whole-value only.** A secret embedded inside a larger logged string is not scrubbed.
- **Redaction governs statelog only, and only inside an execution frame.** `print()` and other direct output are unaffected. Events posted outside an ALS frame (no `__globals()`) are not redacted — redaction is best-effort statelog scrubbing, not a general secrecy guarantee.
- **Rebuild after stdlib changes:** run `make` before any test that runs the compiled CLI (`pnpm run a ...`). Vitest tests run against TS source and need no build.
- **Reserved names:** runtime/internal fields use the existing `__internal` module namespace convention on `GlobalStore`.

---

### Task 1: Tag storage on `GlobalStore`

Add value-keyed (primitive) and reference-keyed (object) tag storage to `GlobalStore`, reusing its existing `toJSON`/`fromJSON`/`clone` machinery so primitive tags are durable and object tags reset on clone. Also add the `redact`-tag owner methods (`markRedacted`/`isRedacted`) and a cheap `hasAnyTags()` gate.

**Files:**
- Modify: `lib/runtime/state/globalStore.ts`
- Test: `lib/runtime/state/globalStore.tags.test.ts` (create)

**Interfaces:**
- Consumes: existing `GlobalStore.get/set`, `GlobalStore.INTERNAL_MODULE`, `clone()`, `toJSON()`, `fromJSON()`.
- Produces:
  - `GlobalStore.setTag(value: unknown, key: string, val: unknown): void`
  - `GlobalStore.getTagsFor(value: unknown): Record<string, unknown> | undefined`
  - `GlobalStore.markRedacted(value: unknown): void`
  - `GlobalStore.isRedacted(value: unknown): boolean`
  - `GlobalStore.hasAnyTags(): boolean`
  - `GlobalStore.REDACT_TAG` (readonly `"redact"`)

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/state/globalStore.tags.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GlobalStore } from "./globalStore.js";

describe("GlobalStore tags", () => {
  it("keys primitive tags by value (all equal primitives share tags)", () => {
    const gs = new GlobalStore();
    gs.setTag("secret", "redact", true);
    // A different string instance with the same value reads the same tags.
    const other = ["sec", "ret"].join("");
    expect(gs.getTagsFor(other)).toEqual({ redact: true });
    expect(gs.getTagsFor("nope")).toBeUndefined();
  });

  it("keeps boolean, number, and string keys distinct", () => {
    const gs = new GlobalStore();
    gs.setTag(1, "a", 1);
    gs.setTag(true, "b", 2);
    expect(gs.getTagsFor(1)).toEqual({ a: 1 });
    expect(gs.getTagsFor("1")).toBeUndefined();
    expect(gs.getTagsFor(true)).toEqual({ b: 2 });
    expect(gs.getTagsFor("true")).toBeUndefined();
  });

  it("keys object tags by reference (structurally-equal objects do not share)", () => {
    const gs = new GlobalStore();
    const o = { id: 1 };
    gs.setTag(o, "redact", true);
    expect(gs.getTagsFor(o)).toEqual({ redact: true });
    expect(gs.getTagsFor({ id: 1 })).toBeUndefined();
  });

  it("merges multiple tags on the same value", () => {
    const gs = new GlobalStore();
    gs.setTag("k", "a", 1);
    gs.setTag("k", "b", 2);
    expect(gs.getTagsFor("k")).toEqual({ a: 1, b: 2 });
  });

  it("getTagsFor does not create the value Map (pure lookup never mutates)", () => {
    const gs = new GlobalStore();
    gs.getTagsFor("x");
    // Nothing was set, so the __internal module slot must not exist yet —
    // a read that created the backing Map would dirty every subsequent clone.
    expect(gs.toJSON().store["__internal"]).toBeUndefined();
  });

  it("markRedacted / isRedacted own the redact tag", () => {
    const gs = new GlobalStore();
    gs.markRedacted("sk");
    expect(gs.isRedacted("sk")).toBe(true);
    expect(gs.isRedacted("other")).toBe(false);
    // isRedacted checks === true, not mere presence.
    gs.setTag("x", "redact", false);
    expect(gs.isRedacted("x")).toBe(false);
    // markRedacted writes the same key user code would via tag(x,"redact",true).
    expect(gs.getTagsFor("sk")).toEqual({ redact: true });
  });

  it("hasAnyTags reflects primitive and object tags", () => {
    const gs = new GlobalStore();
    expect(gs.hasAnyTags()).toBe(false);
    gs.setTag("p", "a", 1);
    expect(gs.hasAnyTags()).toBe(true);
  });

  it("clone() keeps primitive tags but drops object tags", () => {
    const gs = new GlobalStore();
    const o = {};
    gs.setTag("prim", "redact", true);
    gs.setTag(o, "redact", true);
    const c = gs.clone();
    expect(c.getTagsFor("prim")).toEqual({ redact: true });
    expect(c.getTagsFor(o)).toBeUndefined();
    // hasAnyTags tracks the split: object-only presence resets on clone,
    // primitive presence survives. (Pins the branch-local object contract.)
    expect(c.hasAnyTags()).toBe(true); // primitive tag survived
    const objOnly = new GlobalStore();
    objOnly.setTag({}, "redact", true);
    expect(objOnly.hasAnyTags()).toBe(true);
    expect(objOnly.clone().hasAnyTags()).toBe(false); // object tag dropped
  });

  it("survives toJSON/fromJSON for primitive tags (interrupt durability)", () => {
    const gs = new GlobalStore();
    gs.setTag("prim", "redact", true);
    const restored = GlobalStore.fromJSON(gs.toJSON());
    expect(restored.getTagsFor("prim")).toEqual({ redact: true });
    expect(restored.isRedacted("prim")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/state/globalStore.tags.test.ts`
Expected: FAIL — `gs.setTag is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/runtime/state/globalStore.ts`, add fields and methods inside the `GlobalStore` class (place after the existing fields, e.g. just below `initializedModules`):

```ts
  // Object/array/function tags, keyed by reference. Deliberately a WeakMap so
  // it is (a) excluded from toJSON serialization and (b) reset to empty on
  // clone() (fromJSON constructs a fresh GlobalStore). Object identity does
  // not survive the toJSON/fromJSON round-trip, so object tags are
  // intentionally branch-local and do not cross fork/interrupt boundaries.
  private objectTags: WeakMap<object, Record<string, unknown>> = new WeakMap();

  // Tracks whether any object (reference) tag has been set, so hasAnyTags()
  // can answer without enumerating the (non-enumerable) WeakMap. Not
  // serialized and starts false on every fresh store, so it resets on
  // clone()/fromJSON — matching the WeakMap, whose entries also reset.
  private objectTagsPresent = false;

  private static readonly VALUE_TAGS_KEY = "__valueTags";
  static readonly REDACT_TAG = "redact";

  private isRef(value: unknown): value is object {
    return (
      (typeof value === "object" && value !== null) ||
      typeof value === "function"
    );
  }

  // Primitive tags, keyed by value. Stored as a Map under the __internal
  // module so it rides the existing toJSON/fromJSON/clone machinery. The
  // MapReviver serializes entries as [key, value] pairs through JSON, which
  // preserves primitive key *types* (1, "1", and true stay distinct).
  private valueTagMap(): Map<unknown, Record<string, unknown>> {
    let m = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    if (!(m instanceof Map)) {
      m = new Map();
      this.set(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY, m);
    }
    return m as Map<unknown, Record<string, unknown>>;
  }

  // Resolve the tag record for a value. `create` controls whether a missing
  // record (and its backing store slot) is allocated — reads pass false so a
  // pure lookup never mutates state. Unifies the primitive (value Map) and
  // object (WeakMap) paths so setTag/getTagsFor share one code path.
  private tagsRecordFor(
    value: unknown,
    create: boolean,
  ): Record<string, unknown> | undefined {
    if (this.isRef(value)) {
      let t = this.objectTags.get(value);
      if (!t && create) {
        t = {};
        this.objectTags.set(value, t);
        this.objectTagsPresent = true;
      }
      return t;
    }
    const m = create
      ? this.valueTagMap()
      : this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    if (!(m instanceof Map)) return undefined;
    let t = m.get(value);
    if (!t && create) {
      t = {};
      m.set(value, t);
    }
    return t;
  }

  setTag(value: unknown, key: string, val: unknown): void {
    const tags = this.tagsRecordFor(value, true);
    // create=true always yields a record; the guard is for the type checker.
    if (tags) tags[key] = val;
  }

  getTagsFor(value: unknown): Record<string, unknown> | undefined {
    return this.tagsRecordFor(value, false);
  }

  /**
   * Mark a value for statelog redaction. Sole *writer* of the redact tag, so
   * the tag's representation lives in exactly one place. Equivalent to the
   * user-facing tag(value, "redact", true).
   */
  markRedacted(value: unknown): void {
    this.setTag(value, GlobalStore.REDACT_TAG, true);
  }

  /**
   * True when a value is marked redact:true. Sole *reader* of the redact tag
   * (the statelog replacer calls this), so the walker never hard-codes the
   * tag shape.
   */
  isRedacted(value: unknown): boolean {
    return this.getTagsFor(value)?.[GlobalStore.REDACT_TAG] === true;
  }

  /**
   * Cheap "are there any tags at all?" check so statelog can skip installing
   * a redaction replacer entirely when nothing is tagged (the common case).
   * The WeakMap can't report size, so object-tag presence is tracked by a
   * boolean flag that resets on clone alongside the WeakMap.
   */
  hasAnyTags(): boolean {
    if (this.objectTagsPresent) return true;
    const m = this.get(GlobalStore.INTERNAL_MODULE, GlobalStore.VALUE_TAGS_KEY);
    return m instanceof Map && m.size > 0;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/state/globalStore.tags.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Checkpoint (no commit)**

Run the full file once more and confirm green. Per Global Constraints, do **not** `git commit`. Leave changes in the working tree.

---

### Task 2: `makeRedactReplacer` — the statelog redaction replacer

A factory that builds a `JSON.stringify` replacer bound to a branch's `GlobalStore`. The replacer swaps any value marked `redact:true` for `"[REDACTED]"` and leaves everything else untouched. Implemented as a replacer (not a pre-copy deep-walk) so it rides statelog's single `JSON.stringify`, adds no second traversal, and preserves `Date`/`URL`/`toJSON`-bearing values. Kept standalone (own file) so `StatelogClient` imports only this, avoiding import cycles.

**Files:**
- Create: `lib/runtime/redactForStatelog.ts`
- Test: `lib/runtime/redactForStatelog.test.ts` (create)

**Interfaces:**
- Consumes: `GlobalStore.isRedacted` (Task 1); `GlobalStore` type only.
- Produces:
  - `REDACTED` (the `"[REDACTED]"` constant)
  - `makeRedactReplacer(globals: GlobalStore): (this: unknown, key: string, value: unknown) => unknown`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/redactForStatelog.test.ts`. Tests exercise the replacer exactly as `post()` will — through `JSON.stringify` — so they cover the real mechanism, including native-type handling:

```ts
import { describe, it, expect } from "vitest";
import { GlobalStore } from "./state/globalStore.js";
import { makeRedactReplacer } from "./redactForStatelog.js";

// Serialize `body` the way StatelogClient.post does, then parse back so we
// can assert on structure.
function roundtrip(body: unknown, gs: GlobalStore): unknown {
  return JSON.parse(JSON.stringify(body, makeRedactReplacer(gs)));
}

describe("makeRedactReplacer", () => {
  it("redacts a tagged primitive leaf inside an object", () => {
    const gs = new GlobalStore();
    gs.markRedacted("sk-123");
    const body = { url: "https://api.com", apiKey: "sk-123", n: 5 };
    expect(roundtrip(body, gs)).toEqual({
      url: "https://api.com",
      apiKey: "[REDACTED]",
      n: 5,
    });
  });

  it("redacts a tagged object node without descending", () => {
    const gs = new GlobalStore();
    const creds = { user: "a", pass: "b" };
    gs.markRedacted(creds);
    expect(roundtrip({ creds, ok: true }, gs)).toEqual({
      creds: "[REDACTED]",
      ok: true,
    });
  });

  it("walks arrays", () => {
    const gs = new GlobalStore();
    gs.markRedacted("secret");
    expect(roundtrip({ items: ["a", "secret", "b"] }, gs)).toEqual({
      items: ["a", "[REDACTED]", "b"],
    });
  });

  it("preserves an untagged Date (native toJSON is not flattened)", () => {
    // The critical regression guard: a naive Object.entries deep-walk turns a
    // Date into {}. Install a replacer (via an unrelated tag so the path is
    // live) and confirm the Date still serializes to its ISO string.
    const gs = new GlobalStore();
    gs.markRedacted("unrelated");
    const when = new Date("2026-01-01T00:00:00.000Z");
    expect(roundtrip({ when }, gs)).toEqual({ when: "2026-01-01T00:00:00.000Z" });
  });

  it("preserves an untagged value's custom toJSON output", () => {
    const gs = new GlobalStore();
    gs.markRedacted("unrelated");
    const custom = { toJSON: () => "custom-serialized" };
    expect(roundtrip({ v: custom }, gs)).toEqual({ v: "custom-serialized" });
  });

  it("redacts a tagged Date node (reference tag on a non-plain object)", () => {
    const gs = new GlobalStore();
    const when = new Date("2026-01-01T00:00:00.000Z");
    gs.markRedacted(when);
    expect(roundtrip({ when }, gs)).toEqual({ when: "[REDACTED]" });
  });

  it("does not redact a tag whose redact value is not true", () => {
    const gs = new GlobalStore();
    gs.setTag("x", "redact", false);
    gs.setTag("y", "color", "blue");
    expect(roundtrip({ a: "x", b: "y" }, gs)).toEqual({ a: "x", b: "y" });
  });

  it("redacts whole values only — an embedded substring is NOT scrubbed (v1)", () => {
    const gs = new GlobalStore();
    gs.markRedacted("sk-secret");
    const body = { url: "https://api.com?key=sk-secret" };
    // Locks the documented v1 boundary; must be updated deliberately if
    // substring redaction is ever added.
    expect(roundtrip(body, gs)).toEqual(body);
  });

  it("redacts nothing when the store has no tags", () => {
    const gs = new GlobalStore();
    expect(roundtrip({ apiKey: "secret" }, gs)).toEqual({ apiKey: "secret" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/redactForStatelog.test.ts`
Expected: FAIL — cannot find module `./redactForStatelog.js`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/runtime/redactForStatelog.ts`:

```ts
import type { GlobalStore } from "./state/globalStore.js";

export const REDACTED = "[REDACTED]";

/**
 * Build a `JSON.stringify` replacer bound to `globals` that swaps any value
 * marked `redact: true` for "[REDACTED]" and returns everything else
 * unchanged.
 *
 * Implemented as a replacer rather than a pre-copy deep-walk so it (a) runs
 * inside the single JSON.stringify statelog already performs — no second
 * traversal or deep copy — and (b) inherits JSON.stringify's native handling
 * of Date/URL/toJSON-bearing values. A value with a toJSON reaches the
 * replacer already converted to a primitive; `this[key]` still holds the
 * original object, which is what the value/reference tag lookup needs. This
 * mirrors `nativeTypeReplacer` (lib/runtime/revivers/index.ts).
 *
 * Cycles are left to JSON.stringify, which throws on them exactly as the
 * statelog stringify does today — the replacer adds no cycle handling because
 * a cyclic body could never have been serialized in the first place.
 */
export function makeRedactReplacer(
  globals: GlobalStore,
): (this: unknown, key: string, value: unknown) => unknown {
  return function redactReplacer(
    this: unknown,
    key: string,
    value: unknown,
  ): unknown {
    // Recover the raw, pre-toJSON value for the tag lookup.
    let raw: unknown;
    if (typeof value === "object" && value !== null) {
      raw = value;
    } else if (key === "") {
      raw = value;
    } else {
      raw = (this as Record<string, unknown>)[key];
    }
    if (globals.isRedacted(raw)) return REDACTED;
    return value;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/redactForStatelog.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Checkpoint (no commit)**

Run: `pnpm test:run lib/runtime/redactForStatelog.test.ts`
Expected: PASS. Do not commit.

---

### Task 3: `std::tag` TS helpers

The TS implementations behind the `std::tag` agency functions. They read the branch-local `GlobalStore` via the `__globals()` ALS accessor, so tags land on (and read from) the correct branch's store. `_redact` delegates to `GlobalStore.markRedacted` so the redact-tag shape stays owned by `GlobalStore`.

**Files:**
- Create: `lib/stdlib/tag.ts`
- Test: `lib/stdlib/tag.test.ts` (create)

**Interfaces:**
- Consumes: `__globals()` from `lib/runtime/asyncContext.js`; `GlobalStore.setTag/getTagsFor/markRedacted` (Task 1); `runInTestContext` for tests.
- Produces:
  - `_tag(value: unknown, key: string, val: unknown): void`
  - `_getTags(value: unknown): Record<string, unknown>`
  - `_redact(value: unknown): void`

- [ ] **Step 1: Write the failing test**

Create `lib/stdlib/tag.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { _tag, _getTags, _redact } from "./tag.js";

function makeCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
      observability: true,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

describe("std::tag TS helpers", () => {
  it("tags and reads back a primitive by value", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      _tag("secret", "color", "blue");
      expect(_getTags("secret")).toEqual({ color: "blue" });
      expect(_getTags("other")).toEqual({});
    });
  });

  it("tags an object by reference", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      const o = { id: 1 };
      _tag(o, "source", "upload");
      expect(_getTags(o)).toEqual({ source: "upload" });
      expect(_getTags({ id: 1 })).toEqual({}); // distinct reference
    });
  });

  it("redact() sets redact:true (via GlobalStore.markRedacted)", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      _redact("sk-1");
      expect(_getTags("sk-1")).toEqual({ redact: true });
      expect(execCtx.globals.isRedacted("sk-1")).toBe(true);
    });
  });

  it("_getTags returns a copy, not the live store object", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      _tag("k", "a", 1);
      const t = _getTags("k");
      (t as Record<string, unknown>)["a"] = 999;
      expect(_getTags("k")).toEqual({ a: 1 });
    });
  });

  it("_tag is a no-op outside an Agency frame", () => {
    expect(() => _tag("x", "a", 1)).not.toThrow();
    expect(_getTags("x")).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/stdlib/tag.test.ts`
Expected: FAIL — cannot find module `./tag.js`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/stdlib/tag.ts`:

```ts
import { __globals } from "../runtime/asyncContext.js";

/**
 * Attach a tag to a value. Primitives are keyed by value (all equal
 * primitives share tags); objects by reference. No-op outside an Agency
 * execution frame, matching the lenient stdlib convention.
 */
export function _tag(value: unknown, key: string, val: unknown): void {
  const g = __globals();
  if (!g) return;
  g.setTag(value, key, val);
}

/** Return a shallow copy of a value's tags, or {} if none. */
export function _getTags(value: unknown): Record<string, unknown> {
  const t = __globals()?.getTagsFor(value);
  return t ? { ...t } : {};
}

/** Mark a value so it is replaced with "[REDACTED]" in state logs. */
export function _redact(value: unknown): void {
  __globals()?.markRedacted(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/stdlib/tag.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Checkpoint (no commit)**

Run: `pnpm test:run lib/stdlib/tag.test.ts`
Expected: PASS. Do not commit.

---

### Task 4: Wire redaction into `StatelogClient.post`

Install the redaction replacer at the single statelog chokepoint so all ~40 event types are covered, scoped to the `data` payload so envelope/infra fields can never be redacted. Gate on `hasAnyTags()` so tag-free programs (the common case) pay nothing. Integration-tested end-to-end via the `stdout` sink, including the native-type, envelope-immunity, and fork-durability paths.

**Files:**
- Modify: `lib/statelogClient.ts` (imports near top; `post()` body around line 1164)
- Test: `lib/statelogClient.redaction.test.ts` (create)

**Interfaces:**
- Consumes: `makeRedactReplacer` (Task 2); `__globals()` from `lib/runtime/asyncContext.js`; `GlobalStore.setTag/markRedacted/hasAnyTags/clone` (Task 1).
- Produces: redaction applied to every event body inside `post()` before serialization. No new exported symbols.

- [ ] **Step 1: Write the failing test**

Create `lib/statelogClient.redaction.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { runInTestContext } from "./runtime/asyncContext.js";
import { RuntimeContext } from "./runtime/state/context.js";
import { ThreadStore } from "./runtime/state/threadStore.js";

function makeStdoutCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "stdout",
      projectId: "test-project",
      debugMode: false,
      observability: true,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

function printed(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("StatelogClient redaction", () => {
  it("replaces a redact-tagged primitive in a posted event with [REDACTED]", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      execCtx.globals.markRedacted("sk-secret");
      await execCtx.statelogClient.post({ event: "toolCall", args: { apiKey: "sk-secret" } });
    });
    expect(printed(spy)).toContain("[REDACTED]");
    expect(printed(spy)).not.toContain("sk-secret");
  });

  it("leaves untagged values untouched", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      await execCtx.statelogClient.post({ event: "toolCall", args: { city: "Mumbai" } });
    });
    expect(printed(spy)).toContain("Mumbai");
  });

  it("redacts a tagged object node end-to-end", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      const creds = { user: "alice", pass: "hunter2" };
      execCtx.globals.markRedacted(creds);
      await execCtx.statelogClient.post({ event: "toolCall", args: { creds } });
    });
    expect(printed(spy)).toContain("[REDACTED]");
    expect(printed(spy)).not.toContain("hunter2");
  });

  it("does not corrupt an untagged Date in the body (native-type guard)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      // Redaction is live (a tag exists) but the Date is untagged: it must
      // still serialize to its ISO string, not {}.
      execCtx.globals.markRedacted("unrelated");
      await execCtx.statelogClient.post({
        event: "toolCall",
        output: { when: new Date("2026-01-01T00:00:00.000Z") },
      });
    });
    expect(printed(spy)).toContain("2026-01-01T00:00:00.000Z");
  });

  it("never redacts envelope fields even when a colliding value is tagged", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      // 1 === STATELOG_FORMAT_VERSION. A pathological value-tag on 1 must NOT
      // touch the envelope's format_version (scoped-to-data redaction), but the
      // same value inside the payload IS redacted.
      execCtx.globals.markRedacted(1);
      await execCtx.statelogClient.post({ event: "toolCall", args: { n: 1 } });
    });
    expect(printed(spy)).toContain('"format_version":1'); // infra field intact
    expect(printed(spy)).toContain("[REDACTED]"); // payload value redacted
  });

  it("redaction survives a fork-style globals clone (durable primitive path)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    // Tag on the parent store, then run post() against a CLONE of it — exactly
    // what runInBranchAlsFrame does when entering a fork/parallel/race branch.
    // This pins the headline claim: a primitive redact tag set before a fork is
    // still honored inside the branch's post().
    execCtx.globals.markRedacted("sk-fork");
    execCtx.globals = execCtx.globals.clone();
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      await execCtx.statelogClient.post({ event: "toolCall", args: { apiKey: "sk-fork" } });
    });
    expect(printed(spy)).toContain("[REDACTED]");
    expect(printed(spy)).not.toContain("sk-fork");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/statelogClient.redaction.test.ts`
Expected: FAIL — output still contains `sk-secret` (redaction not wired yet).

- [ ] **Step 3: Write minimal implementation**

In `lib/statelogClient.ts`, add imports near the other top-of-file imports:

```ts
import { makeRedactReplacer } from "./runtime/redactForStatelog.js";
import { __globals } from "./runtime/asyncContext.js";
```

Then in `post()`, install the replacer on the existing `JSON.stringify`. Replace:

```ts
    const span = this.currentSpan;
    const postBody = JSON.stringify({
      format_version: STATELOG_FORMAT_VERSION,
      trace_id: this.traceId,
      project_id: this.projectId,
      span_id: span?.spanId ?? null,
      parent_span_id: span?.parentSpanId ?? null,
      data: { ...body, timestamp: new Date().toISOString() },
    });
```

with:

```ts
    const span = this.currentSpan;
    // Single redaction chokepoint: every statelog event flows through post().
    // Redaction is a JSON.stringify *replacer* scoped to the `data` payload
    // ONLY. We stringify the envelope and the payload separately and splice
    // them, so the replacer never runs over infra fields (format_version,
    // trace_id, span ids). This keeps redaction single-pass (no extra deep
    // copy) and preserves Date/URL/toJSON values, while making envelope fields
    // structurally immune to a value-collision — e.g. a pathological
    // `redact(1)` can't blank out `format_version: 1`. The replacer reads the
    // caller's branch tag store via __globals(), synchronously before any
    // detached (noWait) send, so it sees the correct branch. hasAnyTags() skips
    // the replacer entirely when nothing is tagged, so tag-free programs pay
    // nothing. Events posted outside an ALS frame (__globals() undefined) are
    // not redacted — a documented boundary, not a secrecy guarantee.
    const globals = __globals();
    const replacer =
      globals && globals.hasAnyTags() ? makeRedactReplacer(globals) : undefined;
    const envelopeJson = JSON.stringify({
      format_version: STATELOG_FORMAT_VERSION,
      trace_id: this.traceId,
      project_id: this.projectId,
      span_id: span?.spanId ?? null,
      parent_span_id: span?.parentSpanId ?? null,
    });
    const dataJson = JSON.stringify(
      { ...body, timestamp: new Date().toISOString() },
      replacer,
    );
    // Splice: drop the envelope's closing brace and append the data field. The
    // envelope always carries format_version, so envelopeJson is never "{}" and
    // the leading comma is always valid.
    const postBody = `${envelopeJson.slice(0, -1)},"data":${dataJson}}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/statelogClient.redaction.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Guard against import cycles / regressions**

Run the broader statelog + runtime unit suites to confirm no cycle or regression from the new imports.

Run: `pnpm test:run lib/statelogClient.test.ts lib/statelog`
Expected: PASS (no "Cannot access '...' before initialization" cycle errors).

- [ ] **Step 6: Checkpoint (no commit)**

Do not commit. Leave changes in the working tree.

---

### Task 5: `std::tag` Agency module + end-to-end execution tests

Create the user-facing `.agency` module and prove it compiles and works end-to-end through the compiled CLI: tag/read a primitive by value, `redact` sets the redact tag, object tags are by reference, and a primitive tag is inherited by a `fork` branch (the durable path at the language level).

**Files:**
- Create: `stdlib/tag.agency`
- Create: `tests/agency/tag.agency`
- Create: `tests/agency/tag.test.json`

**Interfaces:**
- Consumes: `_tag`, `_getTags`, `_redact` from `agency-lang/stdlib-lib/tag.js` (Task 3; resolves via the `./stdlib-lib/*` → `./dist/lib/stdlib/*` export after `make`).
- Produces: `std::tag` exporting `tag(value, key, val=true)`, `getTags(value)`, `redact(value)`.

- [ ] **Step 1: Write the Agency module**

Create `stdlib/tag.agency`:

```ts
/** @module Attach arbitrary tags to values and read them back anywhere in
your program.

Tags are stored in a side table, so nothing is attached to the value itself
and TypeScript interop is unaffected. Two semantics, by value kind:

- **Primitives** (string, number, boolean) are keyed by **value**: tagging one
  copy of `"secret"` tags every equal `"secret"` in the current branch.
- **Objects and arrays** are keyed by **reference**: tagging one object does
  not tag a structurally-equal but distinct object.

The built-in `redact` tag marks a value so it is replaced with `"[REDACTED]"`
in state logs — useful for API keys and other secrets.

  ```ts
  import { redact } from "std::tag"

  def callApi(apiKey: string) {
    redact(apiKey)          // apiKey shows as "[REDACTED]" in state logs
    return fetch("https://api.example.com", { headers: { key: apiKey } })
  }
  ```

Note: object/array tags are branch-local — they do not survive `fork`/`race`/
`parallel` branches or interrupt/resume. Primitive (value) tags survive both.
*/

import { _tag, _getTags, _redact } from "agency-lang/stdlib-lib/tag.js"

export def tag(value: any, key: string, val: any = true) {
  """Attach a tag to a value. Primitives are keyed by value; objects by
  reference. `val` defaults to `true`."""
  _tag(value, key, val)
}

export def getTags(value: any): any {
  """Return all tags on a value as an object, or an empty object if none."""
  return _getTags(value)
}

export def redact(value: any) {
  """Mark a value so it is replaced with "[REDACTED]" in state logs. Shorthand
  for tag(value, "redact", true)."""
  _redact(value)
}
```

> Note: the nested ```` ```ts ```` fence inside the `@module` docstring matches
> the existing convention in `stdlib/thread.agency`, so `agency doc` handles it.

- [ ] **Step 2: Build so the CLI picks up the new stdlib module**

Run: `make`
Expected: build succeeds; `dist/lib/stdlib/tag.js` and the stdlib copy of `tag.agency` exist. (`std::` modules resolve by file, so no manifest/allowlist needs updating.)

If `std::tag` fails to resolve later, confirm `stdlib/tag.agency` was copied into the build output (that is `make`'s job) and that `dist/lib/stdlib/tag.js` exists.

- [ ] **Step 3: Write the failing execution tests**

Create `tests/agency/tag.agency`:

```ts
import { tag, getTags, redact } from "std::tag"

node valueKeyed(): string {
  const x = "hello"
  tag(x, "color", "blue")
  // Value-keyed: a second identical literal reads the same tags.
  const t = getTags("hello")
  return t["color"]
}

node redactSetsTag(): boolean {
  const key = "sk-abc"
  redact(key)
  const t = getTags("sk-abc")
  return t["redact"] == true
}

node objectByReference(): boolean {
  const a = { id: 1 }
  tag(a, "src", "upload")
  // A distinct object with the same shape does NOT share tags.
  const shared = getTags(a)["src"]
  const b = { id: 1 }
  const bTags = getTags(b)
  // NB: Agency compiles `==` to strict `===`, and a missing object property is
  // `undefined` (not `null`), so `bTags["src"] == null` would be false even
  // when the tag is absent. Assert the tag did not leak by value instead.
  return shared == "upload" && bTags["src"] != "upload"
}

node forkInheritsPrimitiveTag(): boolean {
  // Primitive (value) tags are durable: a fork branch inherits them.
  redact("sk-xyz")
  const results = fork(["only"]) as item {
    const t = getTags("sk-xyz")
    return t["redact"] == true
  }
  return results[0]
}
```

Create `tests/agency/tag.test.json`:

```json
{
  "tests": [
    { "nodeName": "valueKeyed", "input": "", "expectedOutput": "\"blue\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "redactSetsTag", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "objectByReference", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "forkInheritsPrimitiveTag", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] }
  ]
}
```

> Redaction-through-statelog is asserted at the TS integration level (Task 4,
> including the fork-clone durability case), which controls the statelog sink
> directly. These compiled tests pin the language-level surface: value keying,
> `redact` writing the tag, reference semantics, and fork inheritance of a
> primitive tag. Object-tags-drop-on-clone is pinned by the Task 1 unit test.

- [ ] **Step 4: Run the execution tests**

Run: `pnpm run a test tests/agency/tag.agency 2>&1 | tee /tmp/tag-test.out`
Expected: PASS — all four nodes. (Saving to a file per repo testing guidance so failures don't require a rerun.)

- [ ] **Step 5: Checkpoint (no commit)**

Do not commit. Leave changes in the working tree.

---

### Task 6: Guide documentation

Add a user-facing guide page for tags and redaction, and regenerate the stdlib reference from the `tag.agency` docstrings.

**Files:**
- Create: `docs/site/guide/tags.md`
- (Generated) stdlib reference for `std::tag` via `agency doc`

**Interfaces:**
- Consumes: the shipped `std::tag` module (Task 5).
- Produces: documentation only; no code interfaces.

- [ ] **Step 1: Write the guide page**

Create `docs/site/guide/tags.md`:

```markdown
---
name: Tags and Redaction
description: Attach arbitrary tags to values with std::tag, and use the built-in redact tag to keep secrets like API keys out of state logs.
---

# Tags and Redaction

The `std::tag` module lets you attach arbitrary tags to values and read them
back anywhere in your program.

```ts
import { tag, getTags, redact } from "std::tag"

tag(x, "source", "user-upload")   // attach a key/value tag
tag(x, "reviewed")                // value defaults to true
const tags = getTags(x)           // { source: "user-upload", reviewed: true }
```

## Value vs. reference semantics

How a tag is stored depends on the kind of value:

- **Primitives** (string, number, boolean) are keyed by **value**. Tagging one
  copy of `"secret"` tags every equal `"secret"`. This is what makes redacting
  an API key work no matter how the string was copied.
- **Objects and arrays** are keyed by **reference**. Tagging one object does
  *not* tag a structurally-equal but distinct object.

> Object and array tags are branch-local: they do not survive `fork`, `race`,
> or `parallel` branches, or an interrupt/resume. Primitive (value) tags
> survive both.

## Redaction

The built-in `redact` tag marks a value so it is replaced with `"[REDACTED]"`
in [state logs](/guide/observability). Use it for API keys and other secrets:

```ts
import { redact } from "std::tag"

def callApi(apiKey: string) {
  redact(apiKey)
  return fetch("https://api.example.com", { headers: { key: apiKey } })
}
```

`redact(x)` is shorthand for `tag(x, "redact", true)`.

Three limits to know:

- **Whole-value only.** A secret is redacted where it appears as a logged value
  on its own. A secret concatenated into a larger logged string (for example a
  URL query parameter) is *not* scrubbed — tag the exact string that gets
  logged.
- **State logs only.** Redaction governs what `std::statelog` records. It does
  not affect `print()` or other direct output.
- **Not a secrecy guarantee.** Redaction is best-effort scrubbing of state-log
  events emitted while your program runs. It is not an information-flow or
  security control — treat it as a way to keep secrets out of routine telemetry,
  not as a guarantee a secret can never be observed.
```

- [ ] **Step 2: Regenerate the stdlib reference**

Run: `pnpm run agency doc 2>&1 | tee /tmp/tag-doc.out` (or the repo's documented `agency doc` invocation per `docs/site/cli/doc.md`).
Expected: a `docs/site/stdlib/tag.md` page is generated from the `tag.agency` docstrings. Confirm the nested ```` ```ts ```` example in the `@module` doc renders (matches the `thread.agency` precedent).

- [ ] **Step 3: Verify the guide renders and links resolve**

Confirm `docs/site/guide/tags.md` exists and its links (`/guide/observability`) match existing guide filenames.

Run: `ls docs/site/guide/observability.md docs/site/guide/tags.md`
Expected: both files listed.

- [ ] **Step 4: Checkpoint (no commit)**

Do not commit. Leave changes in the working tree.

---

## Self-Review

**Spec coverage:**
- Two stores (primitive by value / object by reference) → Task 1.
- Stored on `GlobalStore`, copy-on-branch, serializable → Task 1 (clone/toJSON tests).
- Identity constraint (primitive durable, object branch-local) → Task 1 (`clone keeps primitive/drops object`, `toJSON survives primitive`, `hasAnyTags` reset-on-clone).
- API `tag`/`getTags`/`redact` in `std::tag` module → Tasks 3 (TS) + 5 (Agency).
- `redact` semantics owned in one place (no magic string spread across files) → Task 1 (`markRedacted`/`isRedacted`/`REDACT_TAG`), consumed by Task 2 replacer and Task 3 `_redact`.
- Redaction at single `post()` chokepoint, as a replacer that preserves native types → Task 4; scoped to `data` so infra fields are immune → Task 4 (envelope/payload splice + envelope-immunity test); fast-path when untagged → Task 4 (`hasAnyTags` gate).
- Whole-value-only, statelog-only, not-a-secrecy-guarantee → enforced/guarded by the replacer (Task 2 substring + redact:false tests) + documented (Task 6).
- Testing bullets from spec:
  - value-vs-reference → Task 1 + Task 3 (object helper) + Task 5 (`objectByReference`).
  - redact through statelog → Task 4 (primitive + object node).
  - **fork/interrupt durability for a primitive → now tested end-to-end**: Task 4 `fork-style globals clone` integration test (proves the branch's `post()` honors an inherited tag) + Task 5 `forkInheritsPrimitiveTag` compiled test. (This was the biggest gap in the prior draft.)
  - object tags NOT surviving fork/interrupt → Task 1 `clone drops object tags` + `hasAnyTags` reset.
  - native-type preservation (Date/toJSON) → Task 2 + Task 4 (regression guard for the replacer rework).
  - embedded-substring NOT redacted (v1 boundary) → Task 2.
  - `shared: true` propagation → a property of the existing GlobalStore pointer-share path; not re-tested here (documented as inherited behavior).
- Docs → Task 6.
- Non-goals (no boxing, no provenance, no substring) → respected; provenance untouched.

**Review findings folded in (from `...-review.md`):**
- Walker→replacer (AP-1 / Must-fix #1 / Should-fix #2): the deep-copy walker is replaced by `makeRedactReplacer`, fixing Date/native-type corruption, removing the unconditional deep copy, and reusing the serialization pass. Tests added for Date and custom-`toJSON`.
- Redact-tag encapsulation (AP-2): `markRedacted`/`isRedacted`/`REDACT_TAG` on `GlobalStore`; the string `"redact"` lives in exactly one place.
- `setTag` duplication (AP-3): unified through `tagsRecordFor(value, create)`.
- Fast-path (Finding B): `hasAnyTags()` gate in `post()`.
- ALS-frame boundary (Finding 4): documented in `post()` comment, Global Constraints, and the guide's "not a secrecy guarantee" note.
- Test gaps: native-type, fork durability, compiled `redact`, substring boundary, `redact:false`, boolean-key distinctness, `getTagsFor` purity — all added.

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type consistency:** `setTag`/`getTagsFor`/`markRedacted`/`isRedacted`/`hasAnyTags` used identically in Tasks 1–4. `_tag`/`_getTags`/`_redact` signatures match between Task 3 impl and Task 5 imports. `makeRedactReplacer(globals)` returns a `JSON.stringify` replacer used identically in Task 2 tests and Task 4.

**Deferred / follow-ups (from spec, intentionally not in this plan):** substring redaction; `pii` and other special tags; low-entropy dev-mode warning; provenance (separate spec); a full compiled interrupt/resume redaction fixture (durability is covered by the Task 1 serialization unit test + the Task 4 clone integration test).
