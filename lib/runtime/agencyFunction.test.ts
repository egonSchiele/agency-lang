import { describe, it, expect } from "vitest";
import { AgencyFunction, UNSET } from "./agencyFunction.js";

function makeFunction(
  params: { name: string; hasDefault?: boolean; defaultValue?: unknown; variadic?: boolean }[],
  fn?: Function,
) {
  return new AgencyFunction({
    name: "testFn",
    module: "test.agency",
    fn: fn ?? (async (...args: unknown[]) => args),
    params: params.map((p) => ({
      name: p.name,
      hasDefault: p.hasDefault ?? false,
      defaultValue: p.defaultValue,
      variadic: p.variadic ?? false,
    })),
    toolDefinition: null,
  });
}

describe("AgencyFunction", () => {
  describe("positional calls", () => {
    it("passes exact args through", async () => {
      const fn = makeFunction([{ name: "a" }, { name: "b" }]);
      const result = await fn.invoke({ type: "positional", args: [1, 2] });
      expect(result).toEqual([1, 2, undefined]); // args + state
    });

    it("pads missing args with UNSET when defaults exist", async () => {
      const fn = makeFunction([
        { name: "a" },
        { name: "b", hasDefault: true, defaultValue: 10 },
      ]);
      const result = await fn.invoke({ type: "positional", args: [1] });
      expect(result).toEqual([1, UNSET, undefined]);
    });

    it("wraps trailing args into array for variadic param", async () => {
      const fn = makeFunction([
        { name: "prefix" },
        { name: "items", variadic: true },
      ]);
      const result = await fn.invoke({ type: "positional", args: [1, 2, 3, 4] });
      expect(result).toEqual([1, [2, 3, 4], undefined]);
    });

    it("passes state through as last argument", async () => {
      const fn = makeFunction([{ name: "a" }]);
      const mockState = { ctx: "mock" } as any;
      const result = await fn.invoke({ type: "positional", args: [1] }, mockState);
      expect(result).toEqual([1, mockState]);
    });

    it("handles zero params", async () => {
      const fn = makeFunction([]);
      const result = await fn.invoke({ type: "positional", args: [] });
      expect(result).toEqual([undefined]); // just state
    });
  });

  describe("named calls", () => {
    it("reorders named args to positional order", async () => {
      const fn = makeFunction([{ name: "a" }, { name: "b" }, { name: "c" }]);
      const result = await fn.invoke({
        type: "named",
        positionalArgs: [],
        namedArgs: { c: 3, a: 1, b: 2 },
      });
      expect(result).toEqual([1, 2, 3, undefined]);
    });

    it("mixes positional and named args", async () => {
      const fn = makeFunction([{ name: "a" }, { name: "b" }, { name: "c" }]);
      const result = await fn.invoke({
        type: "named",
        positionalArgs: [1],
        namedArgs: { c: 3, b: 2 },
      });
      expect(result).toEqual([1, 2, 3, undefined]);
    });

    it("fills skipped optional params with UNSET", async () => {
      const fn = makeFunction([
        { name: "a" },
        { name: "b", hasDefault: true, defaultValue: 10 },
        { name: "c" },
      ]);
      const result = await fn.invoke({
        type: "named",
        positionalArgs: [],
        namedArgs: { a: 1, c: 3 },
      });
      expect(result).toEqual([1, UNSET, 3, undefined]);
    });

    it("pads trailing defaults when named args stop early", async () => {
      const fn = makeFunction([
        { name: "a" },
        { name: "b", hasDefault: true, defaultValue: 10 },
        { name: "c", hasDefault: true, defaultValue: 20 },
      ]);
      const result = await fn.invoke({
        type: "named",
        positionalArgs: [],
        namedArgs: { a: 1 },
      });
      expect(result).toEqual([1, UNSET, UNSET, undefined]);
    });

    it("throws on unknown named arg", async () => {
      const fn = makeFunction([{ name: "a" }]);
      await expect(
        fn.invoke({ type: "named", positionalArgs: [], namedArgs: { z: 1 } }),
      ).rejects.toThrow("Unknown named argument 'z'");
    });

    it("throws on duplicate named arg targeting positional slot", async () => {
      const fn = makeFunction([{ name: "a" }, { name: "b" }]);
      await expect(
        fn.invoke({ type: "named", positionalArgs: [1], namedArgs: { a: 2 } }),
      ).rejects.toThrow("conflicts with positional argument");
    });

    it("throws on missing required arg", async () => {
      const fn = makeFunction([{ name: "a" }, { name: "b" }]);
      await expect(
        fn.invoke({ type: "named", positionalArgs: [], namedArgs: { a: 1 } }),
      ).rejects.toThrow("Missing required argument 'b'");
    });
  });

  describe("serialization properties", () => {
    it("exposes name and module for serialization", () => {
      const fn = makeFunction([{ name: "a" }]);
      expect(fn.name).toBe("testFn");
      expect(fn.module).toBe("test.agency");
    });
  });

  describe("isAgencyFunction", () => {
    it("returns true for AgencyFunction instances", () => {
      const fn = makeFunction([]);
      expect(AgencyFunction.isAgencyFunction(fn)).toBe(true);
    });

    it("returns false for plain objects", () => {
      expect(AgencyFunction.isAgencyFunction({})).toBe(false);
      expect(AgencyFunction.isAgencyFunction(null)).toBe(false);
      expect(AgencyFunction.isAgencyFunction(42)).toBe(false);
      expect(AgencyFunction.isAgencyFunction("hello")).toBe(false);
    });

    it("returns false for objects with __agencyFunction but wrong value", () => {
      expect(AgencyFunction.isAgencyFunction({ __agencyFunction: "yes" })).toBe(false);
    });
  });

  describe("create", () => {
    it("creates instance and registers it in the registry", () => {
      const registry: Record<string, AgencyFunction> = {};
      const fn = AgencyFunction.create({
        name: "add",
        module: "math.agency",
        fn: async () => {},
        params: [],
        toolDefinition: null,
      }, registry);
      expect(registry["add"]).toBe(fn);
      expect(fn.name).toBe("add");
    });
  });
});
