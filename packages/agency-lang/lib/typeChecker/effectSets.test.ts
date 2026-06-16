import { describe, it, expect } from "vitest";
import { resolveEffectSet } from "./effectSets.js";
import type { VariableType } from "../types.js";

const union = (types: VariableType[]): VariableType => ({ type: "unionType", types, isEffectSet: true });
const lit = (value: string): VariableType => ({ type: "stringLiteralType", value });
const ref = (aliasName: string): VariableType => ({ type: "typeAliasVariable", aliasName });
const any: VariableType = { type: "primitiveType", value: "any" };

describe("resolveEffectSet", () => {
  it("resolves a flat literal union to labels", () => {
    expect(resolveEffectSet(union([lit("std::read"), lit("std::write")]), {})).toEqual({
      any: false,
      labels: ["std::read", "std::write"],
      nonEffectSetRefs: [],
    });
  });

  it("resolves the empty set to no labels", () => {
    expect(resolveEffectSet(union([]), {})).toEqual({ any: false, labels: [], nonEffectSetRefs: [] });
  });

  it("resolves <*> (any primitive) to any:true", () => {
    expect(resolveEffectSet(any, {})).toEqual({ any: true, labels: [], nonEffectSetRefs: [] });
  });

  it("flattens a referenced effect set (spread)", () => {
    const aliases = { FsKinds: { body: union([lit("std::read"), lit("std::write")]), isEffectSet: true } };
    expect(resolveEffectSet(union([ref("FsKinds"), lit("std::shell")]), aliases as any)).toEqual({
      any: false,
      labels: ["std::read", "std::write", "std::shell"],
      nonEffectSetRefs: [],
    });
  });

  it("dedupes labels", () => {
    const aliases = { A: { body: union([lit("std::read")]), isEffectSet: true } };
    expect(resolveEffectSet(union([ref("A"), lit("std::read")]), aliases as any)).toEqual({
      any: false,
      labels: ["std::read"],
      nonEffectSetRefs: [],
    });
  });

  it("treats an unknown bare name as a literal effect (bare effects allowed)", () => {
    const result = resolveEffectSet(union([ref("deploy")]), {});
    expect(result).toEqual({ any: false, labels: ["deploy"], nonEffectSetRefs: [] });
  });

  it("reports a reference to a KNOWN alias that is not an effect set", () => {
    const aliases = {
      Color: { body: { type: "unionType", types: [lit("red"), lit("blue")] } },
    };
    const result = resolveEffectSet(union([ref("Color")]), aliases as any);
    expect(result.nonEffectSetRefs).toEqual(["Color"]);
  });
});
