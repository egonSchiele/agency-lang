import { describe, it, expect } from "vitest";
import { deepFreeze } from "./utils.js";

describe("deepFreeze", () => {
  it("freezes a plain object", () => {
    const obj = deepFreeze({ a: 1, b: "hello" });
    expect(Object.isFrozen(obj)).toBe(true);
    expect(() => { (obj as any).a = 2; }).toThrow(TypeError);
  });

  it("freezes nested objects", () => {
    const obj = deepFreeze({ nested: { x: 1 } });
    expect(Object.isFrozen(obj.nested)).toBe(true);
    expect(() => { (obj.nested as any).x = 2; }).toThrow(TypeError);
  });

  it("freezes arrays", () => {
    const arr = deepFreeze([1, 2, 3]);
    expect(Object.isFrozen(arr)).toBe(true);
    expect(() => { (arr as any).push(4); }).toThrow(TypeError);
  });

  it("freezes nested arrays inside objects", () => {
    const obj = deepFreeze({ items: [1, 2] });
    expect(Object.isFrozen(obj.items)).toBe(true);
    expect(() => { (obj.items as any).push(3); }).toThrow(TypeError);
  });

  it("returns primitives as-is", () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("hello")).toBe("hello");
    expect(deepFreeze(true)).toBe(true);
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(undefined)).toBe(undefined);
  });

  it("handles already-frozen objects", () => {
    const obj = Object.freeze({ a: 1 });
    expect(() => deepFreeze(obj)).not.toThrow();
    expect(Object.isFrozen(deepFreeze(obj))).toBe(true);
  });
});
