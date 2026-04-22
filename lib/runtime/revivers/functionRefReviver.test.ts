import { describe, it, expect } from "vitest";
import { FunctionRefReviver } from "./functionRefReviver.js";
import { nativeTypeReplacer, nativeTypeReviver, functionRefReviver } from "./index.js";

function makeRegisteredFunction(name: string, module: string) {
  const fn = function () {} as any;
  fn.__functionRef = { name, module };
  return fn;
}

describe("FunctionRefReviver", () => {
  const reviver = new FunctionRefReviver();

  describe("isInstance", () => {
    it("returns true for functions with __functionRef", () => {
      const fn = makeRegisteredFunction("greet", "test.agency");
      expect(reviver.isInstance(fn)).toBe(true);
    });

    it("returns false for plain functions", () => {
      expect(reviver.isInstance(() => {})).toBe(false);
    });

    it("returns false for non-functions", () => {
      expect(reviver.isInstance("hello")).toBe(false);
      expect(reviver.isInstance(42)).toBe(false);
      expect(reviver.isInstance(null)).toBe(false);
    });
  });

  describe("serialize", () => {
    it("produces correct FunctionRef marker", () => {
      const fn = makeRegisteredFunction("greet", "test.agency");
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
    it("looks up function by original name and module", () => {
      const fn = makeRegisteredFunction("greet", "test.agency");
      const registry = {
        greet: { handler: { execute: fn } },
      } as any;

      reviver.registry = registry;
      const result = reviver.revive({ name: "greet", module: "test.agency" });
      expect(result).toBe(fn);
    });

    it("finds aliased function by original name", () => {
      const fn = makeRegisteredFunction("greet", "utils.agency");
      const registry = {
        sayHello: { handler: { execute: fn } },
      } as any;

      reviver.registry = registry;
      const result = reviver.revive({ name: "greet", module: "utils.agency" });
      expect(result).toBe(fn);
    });

    it("throws when registry is not set", () => {
      reviver.registry = null;
      expect(() => reviver.revive({ name: "greet", module: "test.agency" }))
        .toThrow("no registry set");
    });

    it("throws when function is not found", () => {
      reviver.registry = {} as any;
      expect(() => reviver.revive({ name: "missing", module: "test.agency" }))
        .toThrow("not found in registry");
    });
  });
});

describe("nativeTypeReplacer with functions", () => {
  it("serializes function with __functionRef", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
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

  it("handles functions in arrays", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
    const arr = [1, fn, "hello"];
    const json = JSON.stringify(arr, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed[1]).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
  });

  it("handles nested functions in objects", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
    const obj = { nested: { deep: { callback: fn } } };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const parsed = JSON.parse(json);
    expect(parsed.nested.deep.callback).toEqual({
      __nativeType: "FunctionRef",
      name: "greet",
      module: "test.agency",
    });
  });

  it("handles function refs inside a serialized Set", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
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

  it("handles function refs inside a serialized Map", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
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
  it("round-trips function reference through JSON", () => {
    const fn = makeRegisteredFunction("greet", "test.agency");
    const registry = { greet: { handler: { execute: fn } } } as any;
    functionRefReviver.registry = registry;

    const obj = { callback: fn, data: "hello" };
    const json = JSON.stringify(obj, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.callback).toBe(fn);
    expect(restored.data).toBe("hello");

    // Clean up
    functionRefReviver.registry = null;
  });
});
