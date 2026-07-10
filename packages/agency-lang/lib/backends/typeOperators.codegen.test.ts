import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

function generate(source: string): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success)
    throw new Error(`Failed to parse: ${parseResult.message}`);
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const pre = preprocessor.preprocess();
  const builder = new TypeScriptBuilder({} as AgencyConfig, info, "test.agency");
  return printTs(builder.build(pre));
}

// The zod mapper's fallback for unresolved nodes is z.string(), so every
// assertion here uses a shape the fallback cannot fake.
describe("type operators in alias bodies (deepResolveNode routing)", () => {
  it("type K = keyof User emits the literal-key union, NOT z.string()", () => {
    const out = generate(`
type User = {
  name: string,
  age: number,
}
type K = keyof User
node main() {
  return 1
}
`);
    expect(out).toMatch(
      /const K = z\.union\(\[z\.literal\("name"\), z\.literal\("age"\)\]\)/,
    );
  });

  it("an indexed-access alias emits the property schema (non-string property)", () => {
    const out = generate(`
type User = {
  name: string,
  age: number,
}
type A = User["age"]
node main() {
  return 1
}
`);
    expect(out).toMatch(/const A = z\.number\(\)/);
  });

  it("keyof of a FORWARD alias still emits literal keys (alias table is order-independent)", () => {
    const out = generate(`
type K = keyof Later
type Later = {
  a: string,
  b: number,
}
node main() {
  return 1
}
`);
    expect(out).toContain('z.literal("a")');
  });

  it("an indexed property carrying @validate keeps enforcement (descriptor path)", () => {
    // Tag ride-along must survive codegen, not just unit evaluation:
    // the extracted property type carries the validate tag, so the alias
    // gets a descriptor assignment, not just a bare schema const.
    const out = generate(`
def positive(n: number): Result<number, string> {
  if (n > 0) {
    return success(n)
  }
  return failure("must be positive")
}
type User = {
  name: string,
  @validate(positive)
  age: number,
}
type A = User["age"]
node main() {
  return 1
}
`);
    expect(out).toContain("(A as any).__agency_descriptor");
    expect(out).toContain("const A = z.number()");
  });
});
