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
