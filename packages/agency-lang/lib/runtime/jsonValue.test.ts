import { describe, expect, test } from "vitest";
import { __isJsonValue } from "./jsonValue.js";

describe("__isJsonValue", () => {
  test("accepts json primitives, arrays, and plain objects", () => {
    expect(__isJsonValue(null).ok).toBe(true);
    expect(__isJsonValue("s").ok).toBe(true);
    expect(__isJsonValue(3.5).ok).toBe(true);
    expect(__isJsonValue(false).ok).toBe(true);
    expect(__isJsonValue([1, ["a", null]]).ok).toBe(true);
    expect(__isJsonValue({ a: { b: [1, "x"] } }).ok).toBe(true);
    expect(__isJsonValue(Object.create(null)).ok).toBe(true);
  });

  test("rejects non-round-tripping values with a path", () => {
    expect(__isJsonValue(new Date()).ok).toBe(false);
    expect(__isJsonValue({ a: new Map() }).ok).toBe(false);
    expect(__isJsonValue({ a: [1, NaN] })).toMatchObject({ ok: false, path: "a[1]" });
    expect(__isJsonValue(Infinity).ok).toBe(false);
    expect(__isJsonValue(undefined).ok).toBe(false);
    expect(__isJsonValue({ f: () => 1 }).ok).toBe(false);
  });

  test("rejects cycles instead of hanging", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = __isJsonValue(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("cycle");
    }
  });
});

describe("__isJsonValue round-trip edge cases", () => {
  test("rejects arrays with holes or extra enumerable properties", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(__isJsonValue([1, , 3]).ok).toBe(false);
    const arr: number[] & { x?: number } = [1, 2];
    arr.x = 1;
    expect(__isJsonValue(arr).ok).toBe(false);
  });

  test("rejects symbol-keyed properties", () => {
    const withSymbol: Record<string | symbol, unknown> = { a: 1 };
    withSymbol[Symbol("s")] = 2;
    expect(__isJsonValue(withSymbol).ok).toBe(false);
    const arrWithSymbol: unknown[] = [1];
    (arrWithSymbol as unknown as Record<symbol, unknown>)[Symbol("s")] = 2;
    expect(__isJsonValue(arrWithSymbol).ok).toBe(false);
  });

  test("rejects non-enumerable own properties", () => {
    const hidden = { a: 1 };
    Object.defineProperty(hidden, "secret", { value: 2, enumerable: false });
    expect(__isJsonValue(hidden).ok).toBe(false);
  });
});
