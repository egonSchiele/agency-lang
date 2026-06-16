import { describe, it, expect } from "vitest";
import { effectSetLiteralParser, effectSetDeclParser } from "./parsers.js";
import { parseAgency } from "../parser.js";

describe("effectSetLiteralParser", () => {
  it("parses a two-label set", () => {
    const r = effectSetLiteralParser("<std::read, std::write>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [
        { type: "stringLiteralType", value: "std::read" },
        { type: "stringLiteralType", value: "std::write" },
      ],
    });
  });

  it("parses a single-label set as a one-member union", () => {
    const r = effectSetLiteralParser("<std::read>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [{ type: "stringLiteralType", value: "std::read" }],
    });
  });

  it("parses the empty set as an empty flagged union", () => {
    const r = effectSetLiteralParser("<>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ type: "unionType", isEffectSet: true, types: [] });
  });

  it("parses <*> as the any primitive", () => {
    const r = effectSetLiteralParser("<*>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ type: "primitiveType", value: "any" });
  });

  it("parses a bare identifier as an effect-set reference (TypeAliasVariable)", () => {
    const r = effectSetLiteralParser("<FsKinds, std::shell>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [
        { type: "typeAliasVariable", aliasName: "FsKinds" },
        { type: "stringLiteralType", value: "std::shell" },
      ],
    });
  });
});

describe("effectSetDeclParser", () => {
  it("parses a declaration into a typeAlias with isEffectSet", () => {
    const r = effectSetDeclParser("effectSet FsKinds = <std::read, std::write>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "typeAlias",
      aliasName: "FsKinds",
      isEffectSet: true,
      aliasedType: {
        type: "unionType",
        isEffectSet: true,
        types: [
          { type: "stringLiteralType", value: "std::read" },
          { type: "stringLiteralType", value: "std::write" },
        ],
      },
    });
  });

  it("parses an exported declaration", () => {
    const r = effectSetDeclParser("export effectSet NetKinds = <std::http>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ aliasName: "NetKinds", exported: true, isEffectSet: true });
  });
});

describe("effectSet at module level", () => {
  it("parses as a top-level typeAlias node", () => {
    const parsed = parseAgency('effectSet FsKinds = <std::read>\nnode main() { print("hi") }');
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const alias = parsed.result.nodes.find((n: any) => n.type === "typeAlias");
    expect(alias).toMatchObject({ aliasName: "FsKinds", isEffectSet: true });
  });
});
