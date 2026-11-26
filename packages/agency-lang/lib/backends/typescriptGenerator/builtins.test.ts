import { describe, expect, it } from "vitest";
import { isBuiltinFunction, mapFunctionName } from "./builtins.js";

describe("mapFunctionName", () => {
  it("keeps a name that is a property of every object", () => {
    // A def named like an Object.prototype method is the user's own function.
    for (const name of ["valueOf", "toString", "constructor", "hasOwnProperty"]) {
      expect(mapFunctionName(name)).toBe(name);
      expect(isBuiltinFunction(name)).toBe(false);
    }
  });
});
