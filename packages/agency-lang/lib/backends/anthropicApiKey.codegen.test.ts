import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

// Codegen wiring: anthropicApiKey must be emitted into smoltalkDefaults
// alongside openAiApiKey/googleApiKey — from the agency.json value when
// set, else falling back to the ANTHROPIC_API_KEY env var. Without this,
// Anthropic models can't be used as run-wide defaults the same way the
// other providers can.
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

describe("anthropicApiKey codegen", () => {
  it("emits anthropicApiKey with an ANTHROPIC_API_KEY env fallback by default", () => {
    const out = generate(PROGRAM);
    expect(out).toContain("anthropicApiKey");
    expect(out).toContain("ANTHROPIC_API_KEY");
  });

  it("bakes a literal client.anthropicApiKey when configured", () => {
    const out = generate(PROGRAM, { client: { anthropicApiKey: "sk-ant-test" } });
    expect(out).toContain("sk-ant-test");
  });
});
