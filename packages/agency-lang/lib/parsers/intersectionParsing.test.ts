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

describe("intersection parsing", () => {
  it("parses a two-member intersection", () => {
    expect(firstParamHint("def f(x: A & B) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ aliasName: "A" }, { aliasName: "B" }],
    });
  });

  it("is n-ary: A & B & C is one flat node", () => {
    expect(firstParamHint("def f(x: A & B & C) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ aliasName: "A" }, { aliasName: "B" }, { aliasName: "C" }],
    });
  });

  it("binds tighter than union: A & B | C is (A & B) | C", () => {
    expect(firstParamHint("def f(x: A & B | C) { x }")).toMatchObject({
      type: "unionType",
      types: [
        { type: "intersectionType" },
        { type: "typeAliasVariable", aliasName: "C" },
      ],
    });
  });

  it("binds tighter than union on the right too: A | B & C", () => {
    expect(firstParamHint("def f(x: A | B & C) { x }")).toMatchObject({
      type: "unionType",
      types: [
        { type: "typeAliasVariable", aliasName: "A" },
        { type: "intersectionType" },
      ],
    });
  });

  it("keyof binds tighter: keyof A & B is (keyof A) & B", () => {
    expect(firstParamHint("def f(x: keyof A & B) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ type: "keyofType" }, { aliasName: "B" }],
    });
  });

  it("postfix binds tighter: A[] & B intersects the array", () => {
    expect(firstParamHint("def f(x: A[] & B) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ type: "arrayType" }, { aliasName: "B" }],
    });
  });

  it("parenthesized union as an operand: (A | B) & C", () => {
    expect(firstParamHint("def f(x: (A | B) & C) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ type: "unionType" }, { aliasName: "C" }],
    });
  });

  it("a single member passes through with no intersection node", () => {
    expect(firstParamHint("def f(x: A) { x }")).toMatchObject({
      type: "typeAliasVariable",
      aliasName: "A",
    });
  });

  it("tolerates newlines around the ampersand, like union pipes", () => {
    expect(firstParamHint("def f(x: A &\n  B) { x }")).toMatchObject({
      type: "intersectionType",
    });
  });
});

describe("regression: postfixed inline object types as members", () => {
  it("an inline object type with an array suffix parses as a property value", () => {
    // Found via stdlib/memory.agency: the intersection passthrough made
    // an object-first item order commit to the bare object and strand
    // the [] suffix.
    const parsed = parseAgency(
      "type X = { a: { n: string; t: string }[] }",
    );
    expect(parsed.success).toBe(true);
  });

  it("the same shape works as a UNION member (latent pre-existing gap, now fixed)", () => {
    const parsed = parseAgency("type X = { a: number | { n: string }[] }");
    expect(parsed.success).toBe(true);
  });

  it("and as an intersection member", () => {
    expect(
      firstParamHint("def f(x: { n: string }[] & B) { x }"),
    ).toMatchObject({
      type: "intersectionType",
      types: [{ type: "arrayType" }, { aliasName: "B" }],
    });
  });
});
