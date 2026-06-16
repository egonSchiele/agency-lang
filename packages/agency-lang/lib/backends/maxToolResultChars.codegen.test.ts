import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

// Codegen wiring: agency.json `client.maxToolResultChars` must be baked
// into the generated `new RuntimeContext({...})` args at compile time
// (it is NOT read at runtime). Guards the typescriptBuilder emit so a
// regression there is caught without a full compile-and-run.
function generate(source: string, config?: Partial<AgencyConfig>): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) {
    throw new Error(`Failed to parse: ${parseResult.message}`);
  }
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const pre = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(config as AgencyConfig, info, "test.agency");
  return printTs(builder.build(pre));
}

const PROGRAM = "node main() {\n  const x = 1\n}\n";

describe("maxToolResultChars codegen", () => {
  it("bakes client.maxToolResultChars into the RuntimeContext args", () => {
    const out = generate(PROGRAM, { client: { maxToolResultChars: 4242 } });
    expect(out).toContain("maxToolResultChars: 4242");
  });

  it("omits maxToolResultChars when not configured", () => {
    const out = generate(PROGRAM);
    expect(out).not.toContain("maxToolResultChars");
  });
});
