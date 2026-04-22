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

  describe("legacy support (bare functions with __functionRef)", () => {
    function makeLegacyFunction(name: string, module: string) {
      const fn = function () {} as any;
      fn.__functionRef = { name, module };
      return fn;
    }

    it("isInstance detects legacy functions", () => {
      const fn = makeLegacyFunction("greet", "test.agency");
      expect(reviver.isInstance(fn)).toBe(true);
    });

    it("serializes legacy functions", () => {
      const fn = makeLegacyFunction("greet", "test.agency");
      expect(reviver.serialize(fn)).toEqual({
        __nativeType: "FunctionRef",
        name: "greet",
        module: "test.agency",
      });
    });

    it("revives from legacy registry entries", () => {
      const fn = makeLegacyFunction("greet", "test.agency");
      reviver.registry = { greet: { handler: { execute: fn } } } as any;
      const result = reviver.revive({ name: "greet", module: "test.agency" });
      expect(result).toBe(fn);
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
