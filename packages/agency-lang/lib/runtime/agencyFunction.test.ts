import { describe, it, expect } from "vitest";
import { AgencyFunction, UNSET } from "./agencyFunction.js";
import { runInTestContext } from "./asyncContext.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";
import { ThreadStore } from "./state/threadStore.js";

function makeFunction(
  params: { name: string; hasDefault?: boolean; defaultValue?: unknown; variadic?: boolean }[],
  fn?: (...args: any[]) => any,
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
      expect(result).toEqual([1, 2]);
    });

    it("pads missing args with UNSET when defaults exist", async () => {
      const fn = makeFunction([
        { name: "a" },
        { name: "b", hasDefault: true, defaultValue: 10 },
      ]);
      const result = await fn.invoke({ type: "positional", args: [1] });
      expect(result).toEqual([1, UNSET]);
    });

    it("wraps trailing args into array for variadic param", async () => {
      const fn = makeFunction([
        { name: "prefix" },
        { name: "items", variadic: true },
      ]);
      const result = await fn.invoke({ type: "positional", args: [1, 2, 3, 4] });
      expect(result).toEqual([1, [2, 3, 4]]);
    });

    it("does not forward a trailing state arg to _fn", async () => {
      const seen: unknown[][] = [];
      const fn = makeFunction([{ name: "a" }], (...args: unknown[]) => {
        seen.push(args);
        return "ok";
      });
      await fn.invoke({ type: "positional", args: [42] });
      // Pre-drop, _fn was called as `_fn(42, undefined)` (length 2).
      // Post-drop, only the resolved args make it through.
      expect(seen[0]).toEqual([42]);
    });

    it("rejects unknown second positional via the type system", async () => {
      const fn = makeFunction([{ name: "a" }]);
      // @ts-expect-error — invoke no longer accepts a second positional.
      await fn.invoke({ type: "positional", args: [1] }, { somethingCustom: true });
    });

    it("handles zero params", async () => {
      const fn = makeFunction([]);
      const result = await fn.invoke({ type: "positional", args: [] });
      expect(result).toEqual([]);
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
      expect(result).toEqual([1, 2, 3]);
    });

    it("mixes positional and named args", async () => {
      const fn = makeFunction([{ name: "a" }, { name: "b" }, { name: "c" }]);
      const result = await fn.invoke({
        type: "named",
        positionalArgs: [1],
        namedArgs: { c: 3, b: 2 },
      });
      expect(result).toEqual([1, 2, 3]);
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
      expect(result).toEqual([1, UNSET, 3]);
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
      expect(result).toEqual([1, UNSET, UNSET]);
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
        fn: async () => { },
        params: [],
        toolDefinition: null,
      }, registry);
      expect(registry["math.agency:add"]).toBe(fn);
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
    expect(bound.getUnboundParams()).toHaveLength(1);
    expect(bound.getUnboundParams()[0].name).toBe("b");
    expect(bound.params[0].isBound).toBe(true);
    expect(bound.params[0].boundValue).toBe(5);
  });

  it("binds multiple params", () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    const bound = fn.partial({ a: 1, c: 3 });
    expect(bound.getUnboundParams()).toHaveLength(1);
    expect(bound.getUnboundParams()[0].name).toBe("b");
  });

  it("empty partial returns same instance", () => {
    const fn = makeFunction([
      { name: "a" },
      { name: "b" },
    ]);
    const same = fn.partial({});
    expect(same).toBe(fn);
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
    expect(bound2.getUnboundParams()).toHaveLength(1);
    expect(bound2.getUnboundParams()[0].name).toBe("b");
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
      fn: () => { },
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
      fn: () => { },
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
      fn: () => { },
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
      fn: () => { },
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
      fn: () => { },
      params: [],
      toolDefinition: { name: "foo", description: "old", schema: {} },
    }, {});
    const described = fn.describe("");
    expect(described.toolDefinition!.description).toBe("");
  });

  it("preserves bound params when describing a partial function", () => {
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
    expect(described.params[0].isBound).toBe(true);
    expect(described.getUnboundParams()).toHaveLength(1);
    expect(described.toolDefinition!.description).toBe("Adds 5 to a number");
  });
});

describe("preapprove handler wiring", () => {
  it("invokes via withPushedHandler: handler pushed during call, popped after", async () => {
    const ctx = makeMockCtx();
    let lenDuring = -1;
    const fn = AgencyFunction.create({
      name: "tool",
      module: "test",
      fn: async () => {
        lenDuring = ctx.handlers.length;
        return "x";
      },
      params: [],
      toolDefinition: null,
    }, {}).preapprove();

    const before = ctx.handlers.length;
    await runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () =>
      fn.invoke({ type: "positional", args: [] }),
    );
    expect(lenDuring).toBe(before + 1);
    expect(ctx.handlers.length).toBe(before);
  });

  it("pops the preapprove handler even when the body throws", async () => {
    const ctx = makeMockCtx();
    const fn = AgencyFunction.create({
      name: "tool",
      module: "test",
      fn: async () => {
        throw new Error("boom");
      },
      params: [],
      toolDefinition: null,
    }, {}).preapprove();

    const before = ctx.handlers.length;
    await expect(
      runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () =>
        fn.invoke({ type: "positional", args: [] }),
      ),
    ).rejects.toThrow("boom");
    expect(ctx.handlers.length).toBe(before);
  });

  it("does not push a handler for non-preapproved functions", async () => {
    const ctx = makeMockCtx();
    let lenDuring = -1;
    const fn = AgencyFunction.create({
      name: "tool",
      module: "test",
      fn: async () => {
        lenDuring = ctx.handlers.length;
      },
      params: [],
      toolDefinition: null,
    }, {});

    const before = ctx.handlers.length;
    await runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () =>
      fn.invoke({ type: "positional", args: [] }),
    );
    expect(lenDuring).toBe(before);
  });
});
