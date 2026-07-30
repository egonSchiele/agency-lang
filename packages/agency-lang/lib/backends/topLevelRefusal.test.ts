import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

/**
 * The builder's own refusal, exercised WITHOUT a type check in front of it.
 *
 * This is the only coverage the pre-pass has, and it needs to be: every
 * compile path runs `typeCheck` before building, so the checker's AG3017
 * fires first and nothing else in the suite ever reaches this throw. Delete
 * the pre-pass and only these tests notice — which is the drift the pre-pass
 * exists to prevent.
 */
function build(source: string): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) throw new Error(`Failed to parse: ${parseResult.message}`);
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const pre = preprocessor.preprocess();
  const builder = new TypeScriptBuilder({} as AgencyConfig, info, "test.agency");
  return printTs(builder.build(pre));
}

describe("the builder refuses a top-level statement before generating anything", () => {
  const IF_AT_TOP = "if (true) {\n  print(1)\n}\n\nnode main() { print(2) }\n";

  it("throws with the diagnostic code", () => {
    expect(() => build(IF_AT_TOP)).toThrow(/AG3017/);
  });

  it("does not reach the step machinery", () => {
    // The crash this replaces. If this assertion ever fails, the pre-pass
    // has stopped running and the internal error is back.
    expect(() => build(IF_AT_TOP)).not.toThrow(/StepPathTracker/);
  });

  it("still builds a program whose top level is legal", () => {
    const output = build("const x = 1\n\nnode main() { print(x) }\n");
    expect(output).toContain("main");
  });
});
