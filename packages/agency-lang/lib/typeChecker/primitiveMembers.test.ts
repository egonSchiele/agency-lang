import { describe, it, expect } from "vitest";
import {
  lookupPrimitiveMember,
  resolveSig,
  resolvePropertyType,
} from "./primitiveMembers.js";
import { NUMBER_T, STRING_T, BOOLEAN_T } from "./primitives.js";
import type { VariableType } from "../types.js";

describe("lookupPrimitiveMember", () => {
  it("resolves string.length as a property → number", () => {
    const m = lookupPrimitiveMember(STRING_T, "length");
    expect(m?.kind).toBe("property");
    if (m?.kind === "property") {
      const t = resolvePropertyType(m.type, STRING_T);
      expect(t).toEqual(NUMBER_T);
    }
  });

  it("resolves string literal type as having string members", () => {
    const lit: VariableType = { type: "stringLiteralType", value: "hi" };
    const m = lookupPrimitiveMember(lit, "toUpperCase");
    expect(m?.kind).toBe("method");
  });

  it("resolves array.length as a property → number", () => {
    const arr: VariableType = { type: "arrayType", elementType: STRING_T };
    const m = lookupPrimitiveMember(arr, "length");
    expect(m?.kind).toBe("property");
  });

  it("resolves array.indexOf with element-typed param", () => {
    const arr: VariableType = { type: "arrayType", elementType: NUMBER_T };
    const m = lookupPrimitiveMember(arr, "indexOf");
    expect(m?.kind).toBe("method");
    if (m?.kind === "method") {
      const sig = resolveSig(m.sig, arr);
      expect(sig.params[0]).toEqual(NUMBER_T);
      expect(sig.returnType).toEqual(NUMBER_T);
    }
  });

  it("resolves array.slice to return same Array<T>", () => {
    const arr: VariableType = { type: "arrayType", elementType: BOOLEAN_T };
    const m = lookupPrimitiveMember(arr, "slice");
    expect(m?.kind).toBe("method");
    if (m?.kind === "method") {
      const sig = resolveSig(m.sig, arr);
      expect(sig.returnType).toEqual(arr);
    }
  });

  it("returns null for unknown member on string", () => {
    expect(lookupPrimitiveMember(STRING_T, "nope")).toBeNull();
  });

  it("returns null for non-primitive types", () => {
    expect(lookupPrimitiveMember(NUMBER_T, "toString")).toBeNull();
    expect(lookupPrimitiveMember(BOOLEAN_T, "valueOf")).toBeNull();
  });

  it("does not falsely resolve inherited Object prototype names", () => {
    expect(lookupPrimitiveMember(STRING_T, "toString")).toBeNull();
    expect(lookupPrimitiveMember(STRING_T, "constructor")).toBeNull();
    expect(lookupPrimitiveMember(STRING_T, "hasOwnProperty")).toBeNull();
    const arr: VariableType = { type: "arrayType", elementType: STRING_T };
    expect(lookupPrimitiveMember(arr, "toString")).toBeNull();
  });
});
