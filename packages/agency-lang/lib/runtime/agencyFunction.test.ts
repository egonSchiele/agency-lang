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

describe("partial()", () => {
  it("binds a single param by name", () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b" },
    ]);
    const bound = fn.partial({ a: 5 });
    expect(bound.params).toHaveLength(1);
    expect(bound.params[0].name).toBe("b");
  });

  it("binds multiple params", () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    const bound = fn.partial({ a: 1, c: 3 });
    expect(bound.params).toHaveLength(1);
    expect(bound.params[0].name).toBe("b");
  });

  it("empty partial returns clone with same signature", () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b" },
    ]);
    const clone = fn.partial({});
    expect(clone.params).toHaveLength(2);
    expect(clone).not.toBe(fn);
  });

  it("throws on unknown param name", () => {
    const fn = makeFunction([{ name: "a" }]);
    expect(() => fn.partial({ z: 5 })).toThrow("Unknown parameter 'z'");
  });

  it("chained partial binds remaining params", () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    const bound1 = fn.partial({ a: 1 });
    const bound2 = bound1.partial({ c: 3 });
    expect(bound2.params).toHaveLength(1);
    expect(bound2.params[0].name).toBe("b");
  });

  it("throws when re-binding an already-bound param", () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b" },
    ]);
    const bound = fn.partial({ a: 5 });
    expect(() => bound.partial({ a: 10 })).toThrow("already bound");
  });

  it("throws when binding a variadic param", () => {
    const fn = makeFunction([
      { name: "messages", variadic: true },
    ]);
    expect(() => fn.partial({ messages: ["hi"] })).toThrow("Variadic parameter");
  });

  it("invoke on bound function merges args correctly", async () => {
    const impl = (a: number, b: number, c: number) => a + b + c;
    const fn = AgencyFunction.create({
      name: "add3",
      module: "test",
      fn: impl,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "c", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, {});
    const bound = fn.partial({ a: 10 });
    const result = await bound.invoke({ type: "positional", args: [20, 30] });
    expect(result).toBe(60);
  });

  it("invoke on chained partial merges all bound values", async () => {
    const impl = (a: number, b: number, c: number) => a * 100 + b * 10 + c;
    const fn = AgencyFunction.create({
      name: "combine",
      module: "test",
      fn: impl,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "c", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, {});
    const bound1 = fn.partial({ a: 1 });
    const bound2 = bound1.partial({ c: 3 });
    const result = await bound2.invoke({ type: "positional", args: [2] });
    expect(result).toBe(123);
  });

  it("invoke with middle param bound", async () => {
    const impl = (a: number, b: number, c: number) => a * 100 + b * 10 + c;
    const fn = AgencyFunction.create({
      name: "combine",
      module: "test",
      fn: impl,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "c", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, {});
    const bound = fn.partial({ b: 5 });
    const result = await bound.invoke({ type: "positional", args: [1, 3] });
    expect(result).toBe(153);
  });

  it("invoke bound function with named args", async () => {
    const impl = (a: number, b: number, c: number) => a + b + c;
    const fn = AgencyFunction.create({
      name: "add3",
      module: "test",
      fn: impl,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "c", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, {});
    const bound = fn.partial({ a: 10 });
    const result = await bound.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { c: 30, b: 20 },
    });
    expect(result).toBe(60);
  });

  it("strips @param lines from tool description", () => {
    const fn = AgencyFunction.create({
      name: "readFile",
      module: "test",
      fn: () => {},
      params: [
        { name: "dir", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "filename", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: {
        name: "readFile",
        description: "Read a file.\n@param dir - The directory\n@param filename - The file",
        schema: {},
      },
    }, {});
    const bound = fn.partial({ dir: "/foo" });
    expect(bound.toolDefinition!.description).toBe("Read a file.\n@param filename - The file");
  });
});

describe("describe()", () => {
  it("returns new AgencyFunction with updated description", () => {
    const fn = AgencyFunction.create({
      name: "readFile",
      module: "test",
      fn: () => {},
      params: [
        { name: "filename", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: {
        name: "readFile",
        description: "Original description",
        schema: {},
      },
    }, {});
    const described = fn.describe("New description");
    expect(described.toolDefinition!.description).toBe("New description");
    expect(fn.toolDefinition!.description).toBe("Original description");
  });

  it("works on function without toolDefinition", () => {
    const fn = AgencyFunction.create({
      name: "readFile",
      module: "test",
      fn: () => {},
      params: [],
      toolDefinition: null,
    }, {});
    const described = fn.describe("New description");
    expect(described.toolDefinition!.description).toBe("New description");
    expect(described.toolDefinition!.name).toBe("readFile");
  });

  it("does not mutate original", () => {
    const fn = AgencyFunction.create({
      name: "foo",
      module: "test",
      fn: () => {},
      params: [],
      toolDefinition: { name: "foo", description: "old", schema: {} },
    }, {});
    fn.describe("new");
    expect(fn.toolDefinition!.description).toBe("old");
  });

  it("empty string clears description", () => {
    const fn = AgencyFunction.create({
      name: "foo",
      module: "test",
      fn: () => {},
      params: [],
      toolDefinition: { name: "foo", description: "old", schema: {} },
    }, {});
    const described = fn.describe("");
    expect(described.toolDefinition!.description).toBe("");
  });

  it("preserves boundArgs when describing a partial function", () => {
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: { name: "add", description: "Add.\n@param a - First\n@param b - Second", schema: {} },
    }, {});
    const bound = fn.partial({ a: 5 });
    const described = bound.describe("Adds 5 to a number");
    expect(described.boundArgs).not.toBeNull();
    expect(described.params).toHaveLength(1);
    expect(described.toolDefinition!.description).toBe("Adds 5 to a number");
  });
});
