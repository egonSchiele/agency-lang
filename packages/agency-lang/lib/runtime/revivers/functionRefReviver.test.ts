import { describe, it, expect } from "vitest";
import { AgencyFunction } from "../agencyFunction.js";
import { FunctionRefReviver } from "./functionRefReviver.js";
import { nativeTypeReplacer, nativeTypeReviver, functionRefReviver } from "./index.js";
import { runInTestContext, getRuntimeContext } from "../asyncContext.js";
import { RuntimeContext } from "../state/context.js";
import { StateStack } from "../state/stateStack.js";
import { ThreadStore } from "../state/threadStore.js";

function makeAgencyFunction(name: string, module: string): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: async () => {},
    params: [],
    toolDefinition: null,
  });
}

describe("FunctionRefReviver", () => {
  const reviver = new FunctionRefReviver();

  describe("isInstance", () => {
    it("returns true for AgencyFunction instances", () => {
      const fn = makeAgencyFunction("greet", "test.agency");
      expect(reviver.isInstance(fn)).toBe(true);
    });

    it("returns false for plain functions", () => {
      expect(reviver.isInstance(() => {})).toBe(false);
    });

    it("returns false for non-functions", () => {
      expect(reviver.isInstance("hello")).toBe(false);
      expect(reviver.isInstance(42)).toBe(false);
      expect(reviver.isInstance(null)).toBe(false);
      expect(reviver.isInstance({})).toBe(false);
    });
  });

  describe("serialize", () => {
    it("produces correct FunctionRef marker", () => {
      const fn = makeAgencyFunction("greet", "test.agency");
      const result = reviver.serialize(fn);
      expect(result).toEqual({
        __nativeType: "FunctionRef",
        name: "greet",
        module: "test.agency",
      });
    });
  });

  describe("validate", () => {
    it("accepts valid FunctionRef objects", () => {
      expect(reviver.validate({ name: "greet", module: "test.agency" })).toBe(true);
    });

    it("rejects invalid objects", () => {
      expect(reviver.validate({ name: 123, module: "test.agency" })).toBe(false);
      expect(reviver.validate({ name: "greet" })).toBe(false);
    });
  });

  describe("revive", () => {
    it("looks up AgencyFunction by name and module", () => {
      const fn = makeAgencyFunction("greet", "test.agency");
      reviver.registry = { greet: fn };
      const result = reviver.revive({ name: "greet", module: "test.agency" });
      expect(result).toBe(fn);
    });

    it("finds aliased function by original name+module scan", () => {
      const fn = makeAgencyFunction("greet", "utils.agency");
      // Registry key is "sayHello" (alias), but fn.name is "greet"
      reviver.registry = { sayHello: fn };
      const result = reviver.revive({ name: "greet", module: "utils.agency" });
      expect(result).toBe(fn);
    });

    it("throws when registry is not set", () => {
      reviver.registry = null;
      expect(() => reviver.revive({ name: "greet", module: "test.agency" }))
        .toThrow("no registry set");
    });

    it("revives a missing ordinary function to a tripwire stub (#652)", async () => {
      // revive() also runs during SERIALIZATION (deepClone in State.toJSON),
      // so a miss must never throw eagerly — it would crash checkpoint
      // writes. The stub throws only when invoked.
      reviver.registry = {};
      const stub = reviver.revive({ name: "missing", module: "test.agency" });
      expect(AgencyFunction.isAgencyFunction(stub)).toBe(true);
      expect(stub.name).toBe("missing");
      await expect(
        stub.invoke({ type: "positional", args: [] }),
      ).rejects.toThrow(/never loaded its module/);
    });

    it("revives an unregistered block ref to a stub instead of throwing", () => {
      reviver.registry = {};
      const stub = reviver.revive({
        name: "__block_0",
        module: "stdlib/agency.agency",
      });
      expect(AgencyFunction.isAgencyFunction(stub)).toBe(true);
      expect(stub.name).toBe("__block_0");
      expect(stub.module).toBe("stdlib/agency.agency");
    });

    it("the block stub is a tripwire: invoking it surfaces a rebind error", async () => {
      reviver.registry = {};
      const stub = reviver.revive({
        name: "__block_7",
        module: "test.agency",
      });
      // invoke() may reject or convert the throw to a failure Result
      // depending on failure-propagation settings; accept either, but the
      // tripwire message must surface.
      const outcome = await stub
        .invoke({ type: "positional", args: [] })
        .then((v: unknown) => v, (e: unknown) => e);
      const msg =
        outcome instanceof Error ? outcome.message : JSON.stringify(outcome);
      expect(msg).toContain("before replay rebound it");
    });

    it("near-miss block names revive to the generic stub, not the block stub", async () => {
      // Pins the STRICT block-name predicate: these two must not match
      // isBlockName, and the generic-stub message (vs "before replay
      // rebound it") proves which branch they took.
      reviver.registry = {};
      for (const name of ["__blockish", "__block_"]) {
        const stub = reviver.revive({ name, module: "test.agency" });
        await expect(
          stub.invoke({ type: "positional", args: [] }),
        ).rejects.toThrow(/never loaded its module/);
      }
    });

    it("a REGISTERED block name resolves to the real function, not a stub", () => {
      // Pins the lookup-before-regex ordering: moving the block check ahead
      // of the registry lookup would silently stub every registered block.
      const real = makeAgencyFunction("__block_0", "test.agency");
      reviver.registry = { "test.agency:__block_0": real };
      const result = reviver.revive({
        name: "__block_0",
        module: "test.agency",
      });
      expect(result).toBe(real);
    });
  });
});

describe("nativeTypeReplacer with AgencyFunction", () => {
  it("serializes AgencyFunction in object", () => {
    const fn = makeAgencyFunction("greet", "test.agency");
    const obj = { callback: fn, name: "test" };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed.callback).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
    expect(parsed.name).toBe("test");
  });

  it("handles AgencyFunction in arrays", () => {
    const fn = makeAgencyFunction("greet", "test.agency");
    const arr = [1, fn, "hello"];
    const json = JSON.stringify(arr, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed[1]).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
  });

  it("handles nested AgencyFunction in objects", () => {
    const fn = makeAgencyFunction("greet", "test.agency");
    const obj = { nested: { deep: { callback: fn } } };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed.nested.deep.callback).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
  });

  it("handles AgencyFunction inside a serialized Set", () => {
    const fn = makeAgencyFunction("greet", "test.agency");
    const s = new Set([1, fn, "hello"]);
    const json = JSON.stringify(s, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed.__nativeType).toBe("Set");
    const fnEntry = parsed.values.find((v: any) => v?.__nativeType === "FunctionRef");
    expect(fnEntry).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
  });

  it("handles AgencyFunction inside a serialized Map", () => {
    const fn = makeAgencyFunction("greet", "test.agency");
    const m = new Map<string, any>([["callback", fn], ["data", 42]]);
    const json = JSON.stringify(m, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed.__nativeType).toBe("Map");
    const callbackEntry = parsed.entries.find((e: any) => e[0] === "callback");
    expect(callbackEntry[1]).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
  });
});

describe("full round-trip: serialize then deserialize", () => {
  it("round-trips AgencyFunction through JSON", () => {
    const fn = makeAgencyFunction("greet", "test.agency");
    functionRefReviver.registry = { greet: fn };

    const obj = { callback: fn, data: "hello" };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.callback).toBe(fn);
    expect(restored.data).toBe("hello");

    functionRefReviver.registry = null;
  });
});

describe("FunctionRefReviver with bound functions", () => {
  const reviver = new FunctionRefReviver();

  it("serializes bound function with params", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    const bound = fn.partial({ a: 5 });

    const serialized = reviver.serialize(bound);
    expect(serialized.name).toBe("add");
    expect(serialized.module).toBe("test");
    const params = serialized.params as any[];
    expect(params).toBeDefined();
    expect(params[0].isBound).toBe(true);
    expect(params[0].boundValue).toBe(5);
    expect(params[1].isBound).toBeFalsy();
  });

  it("revives bound function from serialized data", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    reviver.registry = registry;

    const serialized = {
      name: "add",
      module: "test",
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false, isBound: true, boundValue: 5 },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
    };
    const revived = reviver.revive(serialized);
    expect(revived.getUnboundParams()).toHaveLength(1);
    expect(revived.getUnboundParams()[0].name).toBe("b");
    expect(revived.boundArgs).not.toBeNull();
  });

  it("revives unbound function unchanged", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    reviver.registry = registry;

    const revived = reviver.revive({ name: "add", module: "test" });
    expect(revived).toBe(fn);
    expect(revived.boundArgs).toBeNull();
  });

  it("validates records with params", () => {
    expect(reviver.validate({
      name: "add",
      module: "test",
      params: [{ name: "a", isBound: true, boundValue: 5 }],
    })).toBe(true);
  });

  it("round-trips bound function through JSON", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    const bound = fn.partial({ a: 5 });
    functionRefReviver.registry = registry;

    const obj = { callback: bound, data: "test" };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.callback.getUnboundParams()).toHaveLength(1);
    expect(restored.callback.getUnboundParams()[0].name).toBe("b");
    expect(restored.callback.boundArgs).not.toBeNull();
    expect(restored.data).toBe("test");

    functionRefReviver.registry = null;
  });

  it("revives function with custom description from .describe()", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: { name: "add", description: "Add two numbers.\n@param a - First\n@param b - Second", schema: {} },
    }, registry);
    const described = fn.partial({ a: 5 }).describe("Adds 5 to a number");
    functionRefReviver.registry = registry;

    const json = JSON.stringify({ tool: described }, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.tool.toolDefinition.description).toBe("Adds 5 to a number");
    expect(restored.tool.getUnboundParams()).toHaveLength(1);
    expect(restored.tool.getUnboundParams()[0].name).toBe("b");

    functionRefReviver.registry = null;
  });

  it("round-trips .describe() on a function with no original toolDefinition", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "noTool",
      module: "test",
      fn: (a: number) => a,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    const described = fn.describe("Synthesized description");
    functionRefReviver.registry = registry;

    const json = JSON.stringify({ tool: described }, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.tool.toolDefinition).not.toBeNull();
    expect(restored.tool.toolDefinition.description).toBe("Synthesized description");
    expect(restored.tool.toolDefinition.name).toBe("noTool");

    functionRefReviver.registry = null;
  });

  it("round-trips .partial().describe() on a function with no original toolDefinition", () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "noTool",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    const composed = fn.partial({ a: 5 }).describe("Partial + describe");
    functionRefReviver.registry = registry;

    const json = JSON.stringify({ tool: composed }, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.tool.toolDefinition).not.toBeNull();
    expect(restored.tool.toolDefinition.description).toBe("Partial + describe");
    expect(restored.tool.getUnboundParams()).toHaveLength(1);
    expect(restored.tool.getUnboundParams()[0].name).toBe("b");

    functionRefReviver.registry = null;
  });

  it("revived bound function invokes correctly", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "add",
      module: "test",
      fn: (a: number, b: number) => a + b,
      params: [
        { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
        { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: null,
    }, registry);
    const bound = fn.partial({ a: 5 });
    functionRefReviver.registry = registry;

    const json = JSON.stringify({ callback: bound }, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);
    const result = await restored.callback.invoke({ type: "positional", args: [7] });
    expect(result).toBe(12);

    functionRefReviver.registry = null;
  });
});

describe("lazy callback refs (#544)", () => {
  function reviveRef(reviver: FunctionRefReviver, name: string, module: string) {
    return reviver.revive({ __nativeType: "FunctionRef", name, module });
  }

  it("revives a missing __cb_* name as a lazy ref instead of throwing", () => {
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const ref = reviveRef(reviver, "__cb_main_0", "agency_abc") as AgencyFunction;
    expect(AgencyFunction.isAgencyFunction(ref)).toBe(true);
    expect(ref.name).toBe("__cb_main_0");
    expect(ref.module).toBe("agency_abc");
  });

  it("ordinary missing names get the generic stub, not the callback lazy ref", async () => {
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    for (const name of ["myHelper", "__cb_helper"]) {
      const stub = reviveRef(reviver, name, "app.agency") as AgencyFunction;
      // The generic stub is a tripwire: unlike the callback lazy ref, it
      // does NOT re-check the registry at invoke time.
      reviver.registry[`app.agency:${name}`] = makeAgencyFunction(name, "app.agency");
      await expect(
        stub.invoke({ type: "positional", args: [] }),
      ).rejects.toThrow(/never loaded its module/);
    }
  });

  it("does not self-register the lazy ref under the real key", () => {
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    reviveRef(reviver, "__cb_main_0", "agency_abc");
    expect(reviver.registry["agency_abc:__cb_main_0"]).toBeUndefined();
  });

  it("round-trips: serialize(revive(ref)) reproduces the original FunctionRef", () => {
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const ref = reviveRef(reviver, "__cb_main_0", "agency_abc") as AgencyFunction;
    expect(reviver.serialize(ref)).toEqual({
      __nativeType: "FunctionRef",
      name: "__cb_main_0",
      module: "agency_abc",
    });
  });

  it("a registry HIT returns the exact registered instance, never a lazy wrapper", () => {
    // The guard against the lazy branch shadowing the direct path. A
    // fire-count fixture cannot catch that bug (a shadowing lazy ref would
    // resolve and fire anyway); only identity can.
    const reviver = new FunctionRefReviver();
    const real = makeAgencyFunction("__cb_main_0", "agency_abc");
    reviver.registry = { "agency_abc:__cb_main_0": real };
    const revived = reviveRef(reviver, "__cb_main_0", "agency_abc");
    expect(revived).toBe(real);
  });

  it("resolves through the registry at invoke time (late registration)", async () => {
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const ref = reviveRef(reviver, "__cb_main_0", "agency_abc") as AgencyFunction;

    let received: unknown = null;
    reviver.registry["agency_abc:__cb_main_0"] = new AgencyFunction({
      name: "__cb_main_0",
      module: "agency_abc",
      fn: async (data: unknown) => { received = data; },
      params: [{ name: "data", hasDefault: false, defaultValue: undefined, variadic: false }],
      toolDefinition: null,
    });

    await ref.invoke({ type: "positional", args: [{ cost: 1 }] });
    expect(received).toEqual({ cost: 1 });
  });

  it("delegates at the same frame depth as a direct invoke", async () => {
    // Guards the injection/capture specs' frame arithmetic: the lazy fn is
    // a plain arrow (no setupFunction call), so no extra frame may appear.
    const depths: number[] = [];
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const real = new AgencyFunction({
      name: "__cb_main_0",
      module: "agency_abc",
      fn: async () => { depths.push(getRuntimeContext().stack.stack.length); },
      params: [{ name: "data", hasDefault: false, defaultValue: undefined, variadic: false }],
      toolDefinition: null,
    });
    const lazy = reviveRef(reviver, "__cb_main_0", "agency_abc") as AgencyFunction;
    reviver.registry["agency_abc:__cb_main_0"] = real;

    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: process.cwd(),
    });
    await runInTestContext(ctx, new StateStack(), new ThreadStore(), async () => {
      await real.invoke({ type: "positional", args: [{}] });
      await lazy.invoke({ type: "positional", args: [{}] });
    });
    expect(depths).toHaveLength(2);
    expect(depths[1]).toBe(depths[0]);
  });

  it("throws a precise error when fired while still unresolvable", async () => {
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const ref = reviveRef(reviver, "__cb_main_0", "agency_abc") as AgencyFunction;
    await expect(ref.invoke({ type: "positional", args: [{}] })).rejects.toThrow(
      /__cb_main_0.*agency_abc/s,
    );
  });
});

describe("renamed functions round-trip (#652)", () => {
  function makeRegistered(
    registry: Record<string, AgencyFunction>,
  ): AgencyFunction {
    return AgencyFunction.create({
      name: "search",
      module: "stdlib/wikipedia.agency",
      fn: (query: string) => `results for ${query}`,
      params: [
        { name: "query", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      toolDefinition: { name: "search", description: "Search Wikipedia", schema: null },
    }, registry);
  }

  it("serialize records the registered name when the function was renamed", () => {
    const reviver = new FunctionRefReviver();
    const registry: Record<string, AgencyFunction> = {};
    const renamed = makeRegistered(registry).rename("wikipedia_search");
    expect(reviver.serialize(renamed)).toEqual({
      __nativeType: "FunctionRef",
      name: "wikipedia_search",
      module: "stdlib/wikipedia.agency",
      registeredName: "search",
      toolDescription: "Search Wikipedia",
    });
  });

  it("serialize omits registeredName for never-renamed functions", () => {
    const reviver = new FunctionRefReviver();
    const registry: Record<string, AgencyFunction> = {};
    const fn = makeRegistered(registry);
    expect(reviver.serialize(fn)).not.toHaveProperty("registeredName");
  });

  it("a renamed function revives via the registered name and keeps the new name", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const renamed = makeRegistered(registry).rename("wikipedia_search");
    functionRefReviver.registry = registry;

    const json = JSON.stringify({ tool: renamed }, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.tool.name).toBe("wikipedia_search");
    expect(restored.tool.toolDefinition.name).toBe("wikipedia_search");
    const result = await restored.tool.invoke({ type: "positional", args: ["cats"] });
    expect(result).toBe("results for cats");

    functionRefReviver.registry = null;
  });

  it("rename composed with partial round-trips", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const composed = makeRegistered(registry)
      .rename("wikipedia_search")
      .partial({ query: "dogs" });
    functionRefReviver.registry = registry;

    const json = JSON.stringify({ tool: composed }, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.tool.name).toBe("wikipedia_search");
    expect(restored.tool.getUnboundParams()).toHaveLength(0);
    const result = await restored.tool.invoke({ type: "positional", args: [] });
    expect(result).toBe("results for dogs");

    functionRefReviver.registry = null;
  });

  it("deepClone-style round-trip of a renamed ref survives a registry miss intact", () => {
    // The #652 crash shape: State.toJSON deepClones state holding a renamed
    // ref in a process whose registry lacks the module. The clone must
    // reproduce the ref byte-for-byte so the checkpoint stays correct.
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const serialized = {
      __nativeType: "FunctionRef",
      name: "wikipedia_search",
      module: "stdlib/wikipedia.agency",
      registeredName: "search",
      toolDescription: "Search Wikipedia",
    };
    const stub = reviver.revive(serialized) as AgencyFunction;
    expect(reviver.serialize(stub)).toEqual(serialized);
  });

  it("the miss stub preserves bound params and preapproval through re-serialization", () => {
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const serialized = {
      __nativeType: "FunctionRef",
      name: "read",
      module: "stdlib/shell.agency",
      params: [
        { name: "useAgentCwd", hasDefault: false, defaultValue: undefined, variadic: false, isBound: true, boundValue: true },
        { name: "path", hasDefault: false, defaultValue: undefined, variadic: false },
      ],
      isPreapproved: true,
    };
    const stub = reviver.revive(serialized) as AgencyFunction;
    expect(reviver.serialize(stub)).toEqual(serialized);
  });
});

describe("lazy callback refs resolve through the shared lookup", () => {
  it("resolves a legacy bare-name-keyed registry entry at fire time", async () => {
    // Older compiled output keyed the registry by bare name. revive()'s
    // linear scan finds those; the lazy ref must resolve them identically
    // at fire time, or a legacy callback would revive fine and then throw
    // when fired.
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const ref = reviver.revive({
      __nativeType: "FunctionRef", name: "__cb_main_0", module: "agency_abc",
    }) as AgencyFunction;

    let fired = false;
    reviver.registry["__cb_main_0"] = new AgencyFunction({
      name: "__cb_main_0",
      module: "agency_abc",
      fn: async () => { fired = true; },
      params: [{ name: "data", hasDefault: false, defaultValue: undefined, variadic: false }],
      toolDefinition: null,
    });

    await ref.invoke({ type: "positional", args: [{}] });
    expect(fired).toBe(true);
  });
});
