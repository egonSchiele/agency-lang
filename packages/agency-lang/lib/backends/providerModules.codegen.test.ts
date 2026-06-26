import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

function generate(source: string, config?: Partial<AgencyConfig>): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) throw new Error(`Failed to parse: ${parseResult.message}`);
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const pre = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(config as AgencyConfig, info, "test.agency");
  return printTs(builder.build(pre));
}

const PROGRAM = "node main() {\n  const x = 1\n}\n";

describe("providerModules codegen", () => {
  it("bakes client.providerModules into the RuntimeContext args", () => {
    const out = generate(PROGRAM, {
      client: { providerModules: ["./llama-setup.mjs", "/abs/two.mjs"] },
    });
    expect(out).toContain("providerModules");
    expect(out).toContain('"./llama-setup.mjs"');
    expect(out).toContain('"/abs/two.mjs"');
  });

  it("omits providerModules when not configured", () => {
    const out = generate(PROGRAM);
    expect(out).not.toContain("providerModules");
  });
});
