import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

function firstParamHint(source: string): unknown {
  const parsed = parseAgency(source, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("unreachable");
  const def = parsed.result.nodes.find((n) => n.type === "function") as {
    parameters: { typeHint?: unknown }[];
  };
  return def.parameters[0].typeHint;
}

describe("keyof parsing", () => {
  it("parses keyof over an alias reference", () => {
    expect(firstParamHint("def f(k: keyof User) { k }")).toMatchObject({
      type: "keyofType",
      operand: { type: "typeAliasVariable", aliasName: "User" },
    });
  });

  it("binds tighter than union: keyof A | keyof B is a union of keyofs", () => {
    expect(firstParamHint("def f(k: keyof A | keyof B) { k }")).toMatchObject({
      type: "unionType",
      types: [
        { type: "keyofType", operand: { aliasName: "A" } },
        { type: "keyofType", operand: { aliasName: "B" } },
      ],
    });
  });

  it("postfix binds tighter than keyof: keyof User[] is keyof (User[])", () => {
    expect(firstParamHint("def f(k: keyof User[]) { k }")).toMatchObject({
      type: "keyofType",
      operand: { type: "arrayType" },
    });
  });

  it("parenthesized keyof takes a suffix: (keyof User)[] is an ARRAY of keyofs", () => {
    expect(firstParamHint("def f(k: (keyof User)[]) { k }")).toMatchObject({
      type: "arrayType",
      elementType: { type: "keyofType" },
    });
  });

  it("keyword boundary: keyofish stays a plain identifier", () => {
    // The required whitespace after `keyof` is load-bearing: it is what
    // stops the keyword from eating identifier prefixes. Pin it so nobody
    // makes the spaces optional.
    expect(firstParamHint("def f(k: keyofish) { k }")).toMatchObject({
      type: "typeAliasVariable",
      aliasName: "keyofish",
    });
  });
});

describe("indexed access parsing", () => {
  it("parses a string-literal index", () => {
    expect(firstParamHint('def f(x: User["name"]) { x }')).toMatchObject({
      type: "indexedAccessType",
      objectType: { type: "typeAliasVariable", aliasName: "User" },
      index: { type: "stringLiteralType", value: "name" },
    });
  });

  it("parses a union index", () => {
    expect(firstParamHint('def f(x: User["a" | "b"]) { x }')).toMatchObject({
      type: "indexedAccessType",
      index: { type: "unionType" },
    });
  });

  it("chains left to right", () => {
    expect(
      firstParamHint('def f(x: User["address"]["city"]) { x }'),
    ).toMatchObject({
      type: "indexedAccessType",
      objectType: {
        type: "indexedAccessType",
        index: { value: "address" },
      },
      index: { value: "city" },
    });
  });

  it("accepts a full type expression as the index (keyof composes)", () => {
    expect(firstParamHint("def f(x: User[keyof User]) { x }")).toMatchObject({
      type: "indexedAccessType",
      index: { type: "keyofType" },
    });
  });

  it('mixes with arrays: User["tags"][] is an array of the indexed type', () => {
    expect(firstParamHint('def f(x: User["tags"][]) { x }')).toMatchObject({
      type: "arrayType",
      elementType: { type: "indexedAccessType" },
    });
  });

  it("tolerates whitespace inside index brackets (TS parity)", () => {
    expect(firstParamHint('def f(x: User[ "name" ]) { x }')).toMatchObject({
      type: "indexedAccessType",
      index: { type: "stringLiteralType", value: "name" },
    });
  });

  it("parses union operands and objects when parenthesized", () => {
    expect(firstParamHint("def f(k: keyof (A | B)) { k }")).toMatchObject({
      type: "keyofType",
      operand: { type: "unionType" },
    });
    expect(firstParamHint('def f(x: (A | B)["k"]) { x }')).toMatchObject({
      type: "indexedAccessType",
      objectType: { type: "unionType" },
    });
  });

  it("empty brackets still mean array", () => {
    expect(firstParamHint("def f(x: number[]) { x }")).toMatchObject({
      type: "arrayType",
      elementType: { type: "primitiveType", value: "number" },
    });
  });
});
