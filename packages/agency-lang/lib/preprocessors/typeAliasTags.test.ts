import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import { buildCompilationUnit } from "../compilationUnit.js";

describe("attachTags — type aliases", () => {
  it("attaches @validate above a type alias", () => {
    const code = `
@validate(isEmail)
type Email = string
`;
    const parsed = parseAgency(code);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const info = buildCompilationUnit(parsed.result);
    const preprocessor = new TypescriptPreprocessor(parsed.result, {}, info);
    const processed = preprocessor.preprocess();

    const alias = processed.nodes.find(
      (n: any) => n.type === "typeAlias" && n.aliasName === "Email",
    ) as any;
    expect(alias).toBeDefined();
    expect(alias.tags).toHaveLength(1);
    expect(alias.tags[0].name).toBe("validate");
  });

  it("attaches multiple stacked tags above a type alias", () => {
    const code = `
@validate(isEmail)
@jsonSchema({ format: "email" })
type Email = string
`;
    const parsed = parseAgency(code);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const info = buildCompilationUnit(parsed.result);
    const preprocessor = new TypescriptPreprocessor(parsed.result, {}, info);
    const processed = preprocessor.preprocess();

    const alias = processed.nodes.find(
      (n: any) => n.type === "typeAlias" && n.aliasName === "Email",
    ) as any;
    expect(alias.tags).toHaveLength(2);
    expect(alias.tags.map((t: any) => t.name)).toEqual(["validate", "jsonSchema"]);
  });

  it("does not consume tags from a previous alias", () => {
    const code = `
@validate(isEmail)
type Email = string

type Plain = number
`;
    const parsed = parseAgency(code);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const info = buildCompilationUnit(parsed.result);
    const preprocessor = new TypescriptPreprocessor(parsed.result, {}, info);
    const processed = preprocessor.preprocess();

    const plain = processed.nodes.find(
      (n: any) => n.type === "typeAlias" && n.aliasName === "Plain",
    ) as any;
    expect(plain.tags ?? []).toHaveLength(0);
  });
});
