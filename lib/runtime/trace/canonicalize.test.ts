import { describe, it, expect } from "vitest";
import { canonicalize } from "./canonicalize.js";

describe("canonicalize", () => {
  it("sorts object keys alphabetically", () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys", () => {
    const a = canonicalize({ outer: { z: 1, a: 2 } });
    expect(a).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("preserves array order", () => {
    const result = canonicalize([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("handles null", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("handles primitives", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hello")).toBe('"hello"');
    expect(canonicalize(true)).toBe("true");
  });

  it("handles arrays of objects with different key orders", () => {
    const a = canonicalize([{ b: 1, a: 2 }]);
    const b = canonicalize([{ a: 2, b: 1 }]);
    expect(a).toBe(b);
  });

  it("handles undefined values in objects by omitting them", () => {
    const result = canonicalize({ a: 1, b: undefined });
    expect(result).toBe('{"a":1}');
  });

  it("handles deeply nested structures", () => {
    const a = canonicalize({ c: { b: { a: 1 } } });
    expect(a).toBe('{"c":{"b":{"a":1}}}');
  });
});
