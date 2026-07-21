import { describe, expect, test } from "vitest";
import { __coarseTypeTest } from "./typeTest.js";

describe("__coarseTypeTest", () => {
  test("string", () => {
    expect(__coarseTypeTest("hi", "string")).toBe(true);
    expect(__coarseTypeTest(5, "string")).toBe(false);
  });

  test("number, including NaN (typeof semantics)", () => {
    expect(__coarseTypeTest(5, "number")).toBe(true);
    expect(__coarseTypeTest(NaN, "number")).toBe(true);
    expect(__coarseTypeTest("5", "number")).toBe(false);
  });

  test("boolean", () => {
    expect(__coarseTypeTest(false, "boolean")).toBe(true);
    expect(__coarseTypeTest(0, "boolean")).toBe(false);
  });

  test("null is loose: matches undefined like the literal null pattern does", () => {
    // The literal `null` pattern lowers to `== null` (loose), which matches
    // undefined. The coarse check must agree or `null =>` and `_: null`
    // would disagree on interop-produced undefined.
    expect(__coarseTypeTest(null, "null")).toBe(true);
    expect(__coarseTypeTest(undefined, "null")).toBe(true);
    expect(__coarseTypeTest(0, "null")).toBe(false);
    expect(__coarseTypeTest("", "null")).toBe(false);
  });

  test("object excludes null, undefined, and arrays; includes class instances", () => {
    expect(__coarseTypeTest({ a: 1 }, "object")).toBe(true);
    expect(__coarseTypeTest(new Date(), "object")).toBe(true);
    expect(__coarseTypeTest(null, "object")).toBe(false);
    expect(__coarseTypeTest(undefined, "object")).toBe(false);
    expect(__coarseTypeTest([1], "object")).toBe(false);
  });

  test("array", () => {
    expect(__coarseTypeTest([], "array")).toBe(true);
    expect(__coarseTypeTest({ length: 0 }, "array")).toBe(false);
  });

  test("undefined matches no other coarse kind", () => {
    expect(__coarseTypeTest(undefined, "string")).toBe(false);
    expect(__coarseTypeTest(undefined, "number")).toBe(false);
    expect(__coarseTypeTest(undefined, "boolean")).toBe(false);
    expect(__coarseTypeTest(undefined, "array")).toBe(false);
  });
});
