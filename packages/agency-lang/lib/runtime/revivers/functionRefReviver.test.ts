import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgencyFunction } from "../agencyFunction.js";
import type { FuncParam } from "../agencyFunction.js";
import { FunctionRefReviver } from "./functionRefReviver.js";
import { nativeTypeReplacer, nativeTypeReviver, functionRefReviver } from "./index.js";
import { registerClosure, CLOSURE_SELF_SENTINEL } from "../closureRegistry.js";

function makeAgencyFunction(name: string, module: string): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: async () => {},
    params: [],
    toolDefinition: null,
  });
}

const testClosureImpl = async (...args: unknown[]) => args;
const testClosureParams: FuncParam[] = [
  { name: "y", hasDefault: false, defaultValue: undefined, variadic: false },
];

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

describe("FunctionRefReviver closure support", () => {
  const reviver = new FunctionRefReviver();
  const closureKey = "test.agency:outer::inner";

  beforeEach(() => {
    registerClosure(closureKey, { fn: testClosureImpl, params: testClosureParams });
  });

  describe("serialize", () => {
    it("includes closureKey, closureData, toolDefinition, and params for closure functions", () => {
      const fn = new AgencyFunction({
        name: "inner",
        module: "test.agency",
        fn: testClosureImpl,
        params: testClosureParams,
        toolDefinition: { name: "inner", description: "A tool", schema: {} },
        closureData: { multiplier: 6 },
        closureKey,
      });
      const result = reviver.serialize(fn);
      expect(result).toEqual({
        __nativeType: "FunctionRef",
        name: "inner",
        module: "test.agency",
        closureKey,
        closureData: { multiplier: 6 },
        toolDefinition: { name: "inner", description: "A tool", schema: {} },
        params: testClosureParams,
      });
    });

    it("produces minimal output for non-closure functions (backward compatible)", () => {
      const fn = makeAgencyFunction("greet", "test.agency");
      const result = reviver.serialize(fn);
      expect(result).toEqual({
        __nativeType: "FunctionRef",
        name: "greet",
        module: "test.agency",
      });
      expect(result.closureKey).toBeUndefined();
      expect(result.closureData).toBeUndefined();
    });

    it("replaces self-reference with sentinel to avoid circular JSON", () => {
      const fn = new AgencyFunction({
        name: "fib",
        module: "test.agency",
        fn: testClosureImpl,
        params: testClosureParams,
        toolDefinition: null,
        closureData: { fib: null as any },
        closureKey: "test.agency:outer::fib",
      });
      // Set the self-reference
      (fn.closureData as any).fib = fn;

      const result = reviver.serialize(fn);
      expect(result.closureData).toEqual({ fib: CLOSURE_SELF_SENTINEL });
    });
  });

  describe("revive", () => {
    it("reconstructs AgencyFunction from closure registry + closureData", () => {
      const result = reviver.revive({
        name: "inner",
        module: "test.agency",
        closureKey,
        closureData: { multiplier: 6 },
        toolDefinition: { name: "inner", description: "A tool", schema: {} },
        params: testClosureParams,
      });
      expect(result).toBeInstanceOf(AgencyFunction);
      expect(result.name).toBe("inner");
      expect(result.closureKey).toBe(closureKey);
      expect(result.closureData).toEqual({ multiplier: 6 });
    });

    it("replaces __self__ sentinel with the revived AgencyFunction", () => {
      registerClosure("test.agency:outer::fib", { fn: testClosureImpl, params: testClosureParams });
      const result = reviver.revive({
        name: "fib",
        module: "test.agency",
        closureKey: "test.agency:outer::fib",
        closureData: { fib: CLOSURE_SELF_SENTINEL },
        toolDefinition: null,
        params: testClosureParams,
      });
      expect(result.closureData!.fib).toBe(result);
    });

    it("falls back to toolRegistry for non-closure functions", () => {
      const fn = makeAgencyFunction("greet", "test.agency");
      reviver.registry = { greet: fn };
      const result = reviver.revive({ name: "greet", module: "test.agency" });
      expect(result).toBe(fn);
      reviver.registry = null;
    });

    it("throws when closure key is not found in registry", () => {
      expect(() =>
        reviver.revive({
          name: "missing",
          module: "test.agency",
          closureKey: "test.agency:outer::missing",
          closureData: {},
          params: [],
        })
      ).toThrow("cannot revive closure function");
    });
  });

  describe("round-trip", () => {
    it("round-trips closure function through JSON serialize/deserialize", () => {
      const fn = new AgencyFunction({
        name: "inner",
        module: "test.agency",
        fn: testClosureImpl,
        params: testClosureParams,
        toolDefinition: { name: "inner", description: "test", schema: {} },
        closureData: { x: 1, y: "hello", z: [1, 2, 3] },
        closureKey,
      });

      const obj = { tool: fn, data: "test" };
      const json = JSON.stringify(obj, nativeTypeReplacer);
      const restored = JSON.parse(json, nativeTypeReviver);

      expect(restored.tool).toBeInstanceOf(AgencyFunction);
      expect(restored.tool.name).toBe("inner");
      expect(restored.tool.closureKey).toBe(closureKey);
      expect(restored.tool.closureData).toEqual({ x: 1, y: "hello", z: [1, 2, 3] });
      expect(restored.data).toBe("test");
    });

    it("round-trips closure containing another AgencyFunction", () => {
      const helperKey = "test.agency:outer::helper";
      registerClosure(helperKey, { fn: testClosureImpl, params: [] });

      const helper = new AgencyFunction({
        name: "helper",
        module: "test.agency",
        fn: testClosureImpl,
        params: [],
        toolDefinition: null,
        closureData: null,
        closureKey: helperKey,
      });

      const tool = new AgencyFunction({
        name: "tool",
        module: "test.agency",
        fn: testClosureImpl,
        params: testClosureParams,
        toolDefinition: null,
        closureData: { helper },
        closureKey: "test.agency:outer::tool",
      });
      registerClosure("test.agency:outer::tool", { fn: testClosureImpl, params: testClosureParams });

      const json = JSON.stringify({ tool }, nativeTypeReplacer);
      const restored = JSON.parse(json, nativeTypeReviver);

      expect(restored.tool).toBeInstanceOf(AgencyFunction);
      expect(restored.tool.closureData.helper).toBeInstanceOf(AgencyFunction);
      expect(restored.tool.closureData.helper.name).toBe("helper");
    });

    it("round-trips recursive inner function with self-reference", () => {
      const fibKey = "test.agency:outer::fib";
      registerClosure(fibKey, { fn: testClosureImpl, params: testClosureParams });

      const fib = new AgencyFunction({
        name: "fib",
        module: "test.agency",
        fn: testClosureImpl,
        params: testClosureParams,
        toolDefinition: null,
        closureData: { fib: null as any },
        closureKey: fibKey,
      });
      (fib.closureData as any).fib = fib;

      const json = JSON.stringify({ fn: fib }, nativeTypeReplacer);
      const restored = JSON.parse(json, nativeTypeReviver);

      expect(restored.fn).toBeInstanceOf(AgencyFunction);
      expect(restored.fn.closureData.fib).toBe(restored.fn);
    });
  });
});
