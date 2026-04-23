import { describe, it, expect } from "vitest";
import { __call, __callMethod } from "./call.js";
import { AgencyFunction } from "./agencyFunction.js";

function makeAgencyFn(fn: Function, name = "testFn") {
  return new AgencyFunction({
    name,
    module: "test.agency",
    fn,
    params: [{ name: "x", hasDefault: false, defaultValue: undefined, variadic: false }],
    toolDefinition: null,
  });
}

describe("__call", () => {
  it("calls AgencyFunction via .invoke() with descriptor and state", async () => {
    const fn = makeAgencyFn(async (x: number, state: any) => ({ x, state }));
    const result = await __call(fn, { type: "positional", args: [42] }, "myState");
    expect(result).toEqual({ x: 42, state: "myState" });
  });

  it("calls plain TS function by spreading positional args", async () => {
    const fn = (a: number, b: number) => a + b;
    const result = await __call(fn, { type: "positional", args: [3, 4] });
    expect(result).toBe(7);
  });

  it("throws on named args to a TS function", async () => {
    const fn = (a: number) => a;
    await expect(
      __call(fn, { type: "named", positionalArgs: [], namedArgs: { a: 1 } }),
    ).rejects.toThrow("Named arguments are not supported");
  });

  it("throws on non-callable target", async () => {
    await expect(
      __call(42, { type: "positional", args: [] }),
    ).rejects.toThrow("Cannot call non-function value");
  });
});

describe("__callMethod", () => {
  it("calls AgencyFunction stored as object property via .invoke()", async () => {
    const fn = makeAgencyFn(async (x: number, state: any) => x * 2);
    const obj = { myFunc: fn };
    const result = await __callMethod(obj, "myFunc", { type: "positional", args: [5] });
    expect(result).toBe(10);
  });

  it("calls TS method preserving this binding", async () => {
    const s = new Set<number>();
    await __callMethod(s, "add", { type: "positional", args: [42] });
    expect(s.has(42)).toBe(true);
  });

  it("calls AgencyFunction stored in array by index", async () => {
    const fn = makeAgencyFn(async (x: number, state: any) => x + 1);
    const arr = [fn];
    const result = await __callMethod(arr, 0, { type: "positional", args: [10] });
    expect(result).toBe(11);
  });

  it("short-circuits to undefined when optional and obj is null", async () => {
    const result = await __callMethod(null, "foo", { type: "positional", args: [] }, undefined, true);
    expect(result).toBeUndefined();
  });

  it("short-circuits to undefined when optional and obj is undefined", async () => {
    const result = await __callMethod(undefined, "foo", { type: "positional", args: [] }, undefined, true);
    expect(result).toBeUndefined();
  });

  it("calls normally when optional and obj is non-nullish", async () => {
    const obj = { greet: (name: string) => `hi ${name}` };
    const result = await __callMethod(obj, "greet", { type: "positional", args: ["Bob"] }, undefined, true);
    expect(result).toBe("hi Bob");
  });

  it("throws on named args to a TS method", async () => {
    const obj = { fn: (a: number) => a };
    await expect(
      __callMethod(obj, "fn", { type: "named", positionalArgs: [], namedArgs: { a: 1 } }),
    ).rejects.toThrow("Named arguments are not supported");
  });
});
