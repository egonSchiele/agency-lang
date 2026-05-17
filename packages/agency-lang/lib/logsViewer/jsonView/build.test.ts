import { describe, it, expect } from "vitest";
import { buildJsonTree, isLongString } from "./build.js";

describe("buildJsonTree", () => {
  it("classifies primitives by value type", () => {
    expect(buildJsonTree("hi")).toEqual({
      kind: "primitive",
      path: "$",
      valueType: "string",
      raw: '"hi"',
    });
    expect(buildJsonTree(42)).toEqual({
      kind: "primitive",
      path: "$",
      valueType: "number",
      raw: "42",
    });
    expect(buildJsonTree(true)).toEqual({
      kind: "primitive",
      path: "$",
      valueType: "boolean",
      raw: "true",
    });
    expect(buildJsonTree(null)).toEqual({
      kind: "primitive",
      path: "$",
      valueType: "null",
      raw: "null",
    });
  });

  it("preserves insertion order in objects", () => {
    const node = buildJsonTree({ z: 1, a: 2, m: 3 });
    expect(node.kind).toBe("object");
    if (node.kind !== "object") return;
    expect(node.entries.map((e) => e.key)).toEqual(["z", "a", "m"]);
  });

  it("recurses into arrays with index-based paths", () => {
    const node = buildJsonTree([10, 20, 30]);
    expect(node.kind).toBe("array");
    if (node.kind !== "array") return;
    expect(node.items).toHaveLength(3);
    expect(node.items[0].path).toBe("$[0]");
    expect(node.items[2].path).toBe("$[2]");
  });

  it("recurses into nested objects with dotted paths", () => {
    const node = buildJsonTree({ usage: { inputTokens: 100 } });
    if (node.kind !== "object") throw new Error("not an object");
    const usage = node.entries[0].child;
    if (usage.kind !== "object") throw new Error("not an object");
    expect(usage.path).toBe("$.usage");
    expect(usage.entries[0].child.path).toBe("$.usage.inputTokens");
  });

  it("classifies strings with newlines as longString", () => {
    const node = buildJsonTree("hello\nworld");
    expect(node.kind).toBe("longString");
  });

  it("classifies strings longer than 80 chars as longString", () => {
    const node = buildJsonTree("a".repeat(100));
    expect(node.kind).toBe("longString");
  });

  it("classifies short single-line strings as primitive", () => {
    const node = buildJsonTree("short");
    expect(node.kind).toBe("primitive");
  });

  it("handles deeply-nested structures", () => {
    const node = buildJsonTree({ a: { b: { c: { d: 1 } } } });
    if (node.kind !== "object") throw new Error("not an object");
    expect(node.entries[0].child.path).toBe("$.a");
  });

  it("formats numbers like JSON would (no exponential)", () => {
    expect(buildJsonTree(0.000234).raw).toBe("0.000234");
  });

  it("treats NaN/Infinity as null per JSON convention", () => {
    expect(buildJsonTree(NaN).raw).toBe("null");
    expect(buildJsonTree(Infinity).raw).toBe("null");
  });
});

describe("isLongString", () => {
  it("returns true for strings with newlines", () => {
    expect(isLongString("a\nb")).toBe(true);
  });
  it("returns true for strings over 80 chars", () => {
    expect(isLongString("a".repeat(81))).toBe(true);
  });
  it("returns false for short single-line strings", () => {
    expect(isLongString("hello world")).toBe(false);
  });
});
