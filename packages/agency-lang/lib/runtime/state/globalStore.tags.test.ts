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
