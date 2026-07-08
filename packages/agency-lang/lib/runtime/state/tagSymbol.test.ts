import { describe, it, expect } from "vitest";
import {
  TAG_SYMBOL,
  isPlainObjectOrArray,
  canHoldDurableTag,
  attachTag,
  detachTag,
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
    attachTag(o, Object.assign({}, { polluted: true }) as Record<string, unknown>);
    // The record must be null-proto so a "__proto__" key is plain data.
    const rec = readTag(o)!;
    expect(Object.getPrototypeOf(rec)).toBeNull();
    expect(rec.polluted).toBe(true);
  });

  it("readTag returns undefined for untagged / non-object values", () => {
    expect(readTag({})).toBeUndefined();
    expect(readTag("s")).toBeUndefined();
    expect(readTag(null)).toBeUndefined();
  });

  it("detachTag removes the property when extensible, refuses when frozen", () => {
    const o = {};
    attachTag(o, Object.assign(Object.create(null), { x: 1 }));
    expect(detachTag(o)).toBe(true);
    expect(readTag(o)).toBeUndefined();

    const frozen = {};
    attachTag(frozen, Object.assign(Object.create(null), { x: 1 }));
    Object.freeze(frozen);
    expect(detachTag(frozen)).toBe(false); // non-configurable — caller clears keys
    expect(readTag(frozen)).toEqual({ x: 1 });
  });

  it("TAG_SYMBOL is the only way to reach the record", () => {
    const o = {};
    attachTag(o, Object.assign(Object.create(null), { x: 1 }));
    expect((o as Record<symbol, unknown>)[TAG_SYMBOL]).toEqual({ x: 1 });
    expect(Object.getOwnPropertyNames(o)).toEqual([]);
  });
});
