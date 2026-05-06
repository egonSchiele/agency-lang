import { describe, it, expect } from "vitest";
import { AgencyFunction } from "../agencyFunction.js";
import { FunctionRefReviver } from "./functionRefReviver.js";
import { nativeTypeReplacer, nativeTypeReviver, functionRefReviver } from "./index.js";

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

    it("throws when function is not found", () => {
      reviver.registry = {};
      expect(() => reviver.revive({ name: "missing", module: "test.agency" }))
        .toThrow("not found in registry");
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

  it("serializes bound function with boundArgs", () => {
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
    expect((serialized as any).boundArgs).toBeDefined();
    expect((serialized as any).boundArgs.indices).toEqual([0]);
    expect((serialized as any).boundArgs.values).toEqual([5]);
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
      boundArgs: {
        indices: [0],
        values: [5],
        originalParams: fn.params,
      },
    };
    const revived = reviver.revive(serialized);
    expect(revived.params).toHaveLength(1);
    expect(revived.params[0].name).toBe("b");
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

  it("validates records with boundArgs", () => {
    expect(reviver.validate({
      name: "add",
      module: "test",
      boundArgs: { indices: [0], values: [5], originalParams: [] },
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

    expect(restored.callback.params).toHaveLength(1);
    expect(restored.callback.params[0].name).toBe("b");
    expect(restored.callback.boundArgs).not.toBeNull();
    expect(restored.data).toBe("test");

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
