import { describe, it, expect } from "vitest";
import { GlobalStore } from "./globalStore.js";
import { deepClone } from "../utils.js";
import { readTag } from "./tagSymbol.js";

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

  it("clone() keeps primitive tags; FROZEN-object tags stay branch-local", () => {
    // Plain-object tags are durable now (on the object itself — see the
    // durable-tags describe block below); the branch-local contract this test
    // pins is narrowed to objects that can't carry the marker (frozen/native).
    const gs = new GlobalStore();
    const frozen = Object.freeze({ id: 1 });
    gs.setTag("prim", "redact", true);
    gs.setTag(frozen, "redact", true);
    const c = gs.clone();
    expect(c.getTagsFor("prim")).toEqual({ redact: true });
    expect(c.getTagsFor(frozen)).toBeUndefined(); // WeakMap is per-store
    expect(c.hasAnyTags()).toBe(true); // primitive tag survived
    const objOnly = new GlobalStore();
    objOnly.setTag(Object.freeze({}), "redact", true);
    expect(objOnly.hasAnyTags()).toBe(true);
    expect(objOnly.clone().hasAnyTags()).toBe(false); // WeakMap bit resets
  });

  it("survives toJSON/fromJSON for primitive tags (interrupt durability)", () => {
    const gs = new GlobalStore();
    gs.setTag("prim", "redact", true);
    const restored = GlobalStore.fromJSON(gs.toJSON());
    expect(restored.getTagsFor("prim")).toEqual({ redact: true });
    expect(restored.isRedacted("prim")).toBe(true);
  });

  it("ignores bigint and symbol values (keeps serialization safe)", () => {
    const gs = new GlobalStore();
    gs.setTag(10n, "a", 1);
    gs.setTag(Symbol("s"), "a", 1);
    expect(gs.getTagsFor(10n)).toBeUndefined();
    expect(gs.hasAnyTags()).toBe(false);
    // The unsupported keys must not have created a Map that would throw here.
    expect(() => gs.toJSON()).not.toThrow();
  });

  it("a __proto__ tag key does not pollute Object.prototype", () => {
    const gs = new GlobalStore();
    gs.setTag("v", "__proto__", { polluted: true });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    // It is stored as an own data property on the (null-proto) record.
    expect(gs.getTagsFor("v")?.["__proto__"]).toEqual({ polluted: true });
  });

  it("removeTag deletes a single key; removeAllTags clears the value", () => {
    const gs = new GlobalStore();
    gs.setTag("k", "a", 1);
    gs.setTag("k", "b", 2);
    gs.removeTag("k", "a");
    expect(gs.getTagsFor("k")).toEqual({ b: 2 });
    gs.removeAllTags("k");
    expect(gs.getTagsFor("k")).toBeUndefined();
    expect(gs.hasAnyTags()).toBe(false);
    // Durable (plain-object) path: the symbol property is detached outright
    // (the object stops matching the TaggedReviver), so getTagsFor returns
    // undefined like the other paths. Only a frozen-after-tag target keeps
    // the cleared-in-place {} record — see the durable block below.
    const o = {};
    gs.setTag(o, "x", 1);
    gs.removeAllTags(o);
    expect(gs.getTagsFor(o)).toBeUndefined();
    expect(readTag(o)).toBeUndefined();
    // WeakMap (frozen) path: the entry is deleted, so getTagsFor is undefined.
    const frozen = Object.freeze({});
    gs.setTag(frozen, "x", 1);
    gs.removeAllTags(frozen);
    expect(gs.getTagsFor(frozen)).toBeUndefined();
  });

  describe("durable object tags", () => {
    it("stores a plain object's tag ON the object (survives deepClone)", () => {
      const gs = new GlobalStore();
      const o = { id: 1 };
      gs.setTag(o, "redact", true);
      expect(readTag(o)).toEqual({ redact: true }); // on the object
      const cloned = deepClone(o);
      expect(gs.getTagsFor(cloned)).toEqual({ redact: true }); // durable
      expect(gs.isRedacted(cloned)).toBe(true);
    });

    it("frozen and native-typed objects fall back to the WeakMap (branch-local)", () => {
      const gs = new GlobalStore();
      const frozen = Object.freeze({ id: 1 });
      const date = new Date();
      gs.setTag(frozen, "redact", true);
      gs.setTag(date, "redact", true);
      expect(readTag(frozen)).toBeUndefined(); // not on the object
      expect(gs.getTagsFor(frozen)).toEqual({ redact: true }); // in WeakMap
      expect(gs.getTagsFor(date)).toEqual({ redact: true });
    });

    it("resolves a tag on an object frozen AFTER tagging (read/remove first)", () => {
      const gs = new GlobalStore();
      const o: Record<string, unknown> = { id: 1 };
      gs.setTag(o, "redact", true); // durable path (extensible)
      Object.freeze(o); // now non-extensible
      expect(gs.getTagsFor(o)).toEqual({ redact: true }); // still found
      gs.setTag(o, "extra", 1); // mutates the record, no throw
      expect(gs.getTagsFor(o)).toEqual({ redact: true, extra: 1 });
      expect(() => gs.removeAllTags(o)).not.toThrow(); // clears keys, no delete
      // NOTE: intentional, narrow asymmetry — a FROZEN-after-tag target keeps
      // an empty {} record (its symbol property is non-configurable, so it
      // can't be detached; keys are cleared in place instead). Extensible
      // targets get the property detached and return undefined like every
      // other path. Don't "unify" this to an unconditional delete: it throws
      // here. isRedacted (=== true) is unaffected.
      expect(gs.getTagsFor(o)).toEqual({});
      expect(gs.isRedacted(o)).toBe(false);
    });

    it("durable flag survives clone/fromJSON (parent->child); WeakMap flag resets", () => {
      const gs = new GlobalStore();
      gs.setTag({ id: 1 }, "redact", true); // durable
      expect(gs.hasDurableObjectTagFlag()).toBe(true);
      expect(gs.clone().hasDurableObjectTagFlag()).toBe(true);
      expect(GlobalStore.fromJSON(gs.toJSON()).hasAnyTags()).toBe(true);

      const weakOnly = new GlobalStore();
      weakOnly.setTag(Object.freeze({}), "redact", true); // WeakMap path
      expect(weakOnly.hasAnyTags()).toBe(true);
      expect(weakOnly.clone().hasAnyTags()).toBe(false); // WeakMap bit resets
    });

    it("adding a tag to an object tagged by ANOTHER store sets this store's durable flag", () => {
      // The durable record rides ON the object, so a store can adopt one it
      // never created (object arrived by reference, e.g. from a settled
      // branch). A write through this store must set ITS flag — the redaction
      // gate has to be locally true, not dependent on join-propagation order.
      const a = new GlobalStore();
      const b = new GlobalStore();
      const o = { id: 1 };
      a.setTag(o, "redact", true); // record created via store A
      expect(b.hasDurableObjectTagFlag()).toBe(false);
      b.setTag(o, "extra", 1); // store B adopts the existing record
      expect(b.hasDurableObjectTagFlag()).toBe(true);
    });

    it("setDurableObjectTagFlag is idempotent and readable", () => {
      const gs = new GlobalStore();
      expect(gs.hasDurableObjectTagFlag()).toBe(false);
      gs.setDurableObjectTagFlag();
      gs.setDurableObjectTagFlag();
      expect(gs.hasDurableObjectTagFlag()).toBe(true);
      expect(gs.hasAnyTags()).toBe(true);
    });
  });
});
