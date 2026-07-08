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
    const cloned = deepClone({ outer: { inner } }) as {
      outer: { inner: object };
    };
    expect(cloned.outer.inner).toEqual({ secret: "s" });
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
