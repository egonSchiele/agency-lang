import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgencyFunction, UNSET } from "./agencyFunction.js";
import { runInTestContext } from "./asyncContext.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";
import { ThreadStore } from "./state/threadStore.js";
import { CallDepthExceededError } from "./errors.js";

function makeNamedFunction(
  name: string,
  fn: (...args: any[]) => any,
  params: { name: string }[] = [],
) {
  return new AgencyFunction({
    name,
    module: "test.agency",
    fn,
    params: params.map((p) => ({
      name: p.name,
      hasDefault: false,
      defaultValue: undefined,
      variadic: false,
    })),
    toolDefinition: null,
  });
}

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

  describe("call-depth guard", () => {
    const noArgs = { type: "positional" as const, args: [] };

    it("trips CallDepthExceededError on unbounded mutual recursion", async () => {
      const ctx = makeMockCtx();
      ctx.maxCallDepth = 5;
      // foo's body references bar before bar is declared; the arrow only runs
      // at call time (after both exist), so const forward-reference is fine.
      const foo = makeNamedFunction("foo", () => bar.invoke(noArgs));
      const bar = makeNamedFunction("bar", () => foo.invoke(noArgs));
      await runInTestContext(ctx, ctx.stateStack, ctx.threads, async () => {
        await expect(foo.invoke(noArgs)).rejects.toBeInstanceOf(
          CallDepthExceededError,
        );
      });
    });

    it("allows recursion that stays under the limit", async () => {
      const ctx = makeMockCtx();
      ctx.maxCallDepth = 100;
      const countdown: AgencyFunction = makeNamedFunction(
        "countdown",
        (n: number) =>
          n <= 0
            ? "done"
            : countdown.invoke({ type: "positional", args: [n - 1] }),
        [{ name: "n" }],
      );
      await runInTestContext(ctx, ctx.stateStack, ctx.threads, async () => {
        await expect(
          countdown.invoke({ type: "positional", args: [10] }),
        ).resolves.toBe("done");
      });
    });

    it("counts logical depth, not V8 stack (async recursion trips)", async () => {
      const ctx = makeMockCtx();
      ctx.maxCallDepth = 20;
      // Each call awaits before recursing, flattening V8's stack — only the
      // logical depth counter can catch this.
      const self: AgencyFunction = makeNamedFunction("selfAsync", async () => {
        await Promise.resolve();
        return self.invoke(noArgs);
      });
      await runInTestContext(ctx, ctx.stateStack, ctx.threads, async () => {
        await expect(self.invoke(noArgs)).rejects.toBeInstanceOf(
          CallDepthExceededError,
        );
      });
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

  it("binds a variadic param via the named-array form", () => {
    const fn = makeFunction([
      { name: "messages", variadic: true },
    ]);
    const bound = fn.partial({ messages: ["hi", "there"] });
    expect(bound.getUnboundParams()).toHaveLength(0);
  });

  it("rejects binding a variadic to a non-array value", () => {
    const fn = makeFunction([
      { name: "messages", variadic: true },
    ]);
    expect(() => fn.partial({ messages: "hi" })).toThrow(
      "Variadic parameter 'messages' must be bound to an array",
    );
  });

  // Spec 2026-06-03 §5.5 #47 (runtime half of the test). The type checker
  // rejects this at compile time; the runtime is a backstop for callers
  // that bypass the type checker (generated TS, manual runtime usage).
  it("rejects positional args past the fixed count when variadic is bound by name", async () => {
    const impl = (a: number, rest: number[]) => [a, rest];
    const fn = AgencyFunction.create(
      {
        name: "foo",
        module: "test.agency",
        fn: impl,
        params: [
          { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
          { name: "rest", hasDefault: false, defaultValue: undefined, variadic: true },
        ],
        toolDefinition: null,
      },
      {},
    );
    await expect(
      fn.invoke({
        type: "named",
        positionalArgs: [1, 2],
        namedArgs: { rest: [3] },
      }),
    ).rejects.toThrow(/Positional argument cannot feed variadic/);
  });

  it("accepts named-variadic binding via invoke (runtime mirror of compile-time test)", async () => {
    const impl = (a: number, rest: number[]) => ({ a, rest });
    const fn = AgencyFunction.create(
      {
        name: "foo",
        module: "test.agency",
        fn: impl,
        params: [
          { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
          { name: "rest", hasDefault: false, defaultValue: undefined, variadic: true },
        ],
        toolDefinition: null,
      },
      {},
    );
    const out = await fn.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { a: 10, rest: [1, 2, 3] },
    });
    expect(out).toEqual({ a: 10, rest: [1, 2, 3] });
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

  // Spec 2026-06-03 §5.6 #52: after PFA-binding a variadic, the reduced
  // schema no longer carries the variadic's field.
  it("removes the variadic field from the reduced schema after PFA binding", () => {
    const schema = z.object({
      a: z.number(),
      rest: z.array(z.number()),
    });
    const fn = AgencyFunction.create(
      {
        name: "foo",
        module: "test",
        fn: () => {},
        params: [
          { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
          { name: "rest", hasDefault: false, defaultValue: undefined, variadic: true },
        ],
        toolDefinition: {
          name: "foo",
          description: "Adds.",
          schema,
        },
      },
      {},
    );
    const bound = fn.partial({ rest: [1, 2] });
    const newSchema = bound.toolDefinition!.schema as z.ZodObject<Record<string, z.ZodTypeAny>>;
    expect(Object.keys(newSchema.shape)).toEqual(["a"]);
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

describe("rename()", () => {
  it("changes both the function name and the tool-definition name", () => {
    const fn = new AgencyFunction({
      name: "read",
      module: "test.agency",
      fn: async (...args: unknown[]) => args,
      params: [{ name: "filename", hasDefault: false, defaultValue: undefined, variadic: false }],
      toolDefinition: { name: "read", description: "Read a file", schema: null },
    });
    const renamed = fn.rename("skills_docs_guide");
    expect(renamed.name).toBe("skills_docs_guide");
    expect(renamed.toolDefinition?.name).toBe("skills_docs_guide");
    // Description is preserved.
    expect(renamed.toolDefinition?.description).toBe("Read a file");
    // Original is untouched (immutable copy).
    expect(fn.name).toBe("read");
  });

  it("leaves toolDefinition null when the base has none", () => {
    const fn = new AgencyFunction({
      name: "helper",
      module: "test.agency",
      fn: async () => "ok",
      params: [],
      toolDefinition: null,
    });
    const renamed = fn.rename("renamedHelper");
    expect(renamed.name).toBe("renamedHelper");
    expect(renamed.toolDefinition).toBeNull();
  });

  it("composes with partial/describe and remains invocable under the new name", async () => {
    const fn = new AgencyFunction({
      name: "read",
      module: "test.agency",
      fn: async (...args: unknown[]) => args,
      params: [
        { name: "dir", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "filename", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: { name: "read", description: "Read a file", schema: null },
    });
    const tool = fn.partial({ dir: "/tmp" }).describe("docs").rename("skills_tmp");
    expect(tool.name).toBe("skills_tmp");
    expect(tool.toolDefinition?.name).toBe("skills_tmp");
    expect(tool.toolDefinition?.description).toBe("docs");
    // The bound `dir` is still applied when invoked.
    const result = await tool.invoke({ type: "positional", args: ["a.txt"] });
    expect(result).toEqual(["/tmp", "a.txt"]);
  });
});
