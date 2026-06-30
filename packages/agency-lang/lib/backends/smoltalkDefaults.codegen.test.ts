import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

// Codegen wiring: API keys are emitted into smoltalkDefaults under a nested
// `apiKey` map (and base URLs under `baseUrl`), each falling back to its
// conventional env var when not set in agency.json. These tests guard the
// shape of that generated block for the built-in and hosted providers.
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

describe("smoltalkDefaults codegen", () => {
  it("emits a nested apiKey map with env fallbacks by default", () => {
    const out = generate(PROGRAM);
    expect(out).toContain("apiKey");
    expect(out).toContain("OPENAI_API_KEY");
    expect(out).toContain("GEMINI_API_KEY");
    expect(out).toContain("ANTHROPIC_API_KEY");
    // the old flat field names must be gone
    expect(out).not.toContain("openAiApiKey");
    expect(out).not.toContain("anthropicApiKey");
  });

  it("bakes a literal client.apiKey.anthropic when configured", () => {
    const out = generate(PROGRAM, { client: { apiKey: { anthropic: "sk-ant-test" } } });
    expect(out).toContain("sk-ant-test");
  });

  it("emits the hosted providers' apiKey env fallbacks", () => {
    const out = generate(PROGRAM);
    expect(out).toContain("OPENROUTER_API_KEY");
    expect(out).toContain("DEEPINFRA_API_KEY");
    expect(out).toContain("LITELLM_API_KEY");
    expect(out).toContain("OPENAI_COMPAT_API_KEY");
  });

  it("emits a baseUrl map with litellm/openai-compat env fallbacks", () => {
    const out = generate(PROGRAM);
    expect(out).toContain("baseUrl");
    expect(out).toContain("LITELLM_BASE_URL");
    expect(out).toContain("OPENAI_COMPAT_BASE_URL");
  });

  it("bakes a configured openRouter base URL override", () => {
    const out = generate(PROGRAM, { client: { baseUrl: { openRouter: "https://proxy.test/v1" } } });
    expect(out).toContain("https://proxy.test/v1");
  });

  it("omits provider when defaultProvider is unset", () => {
    const out = generate(PROGRAM);
    // anchor to a baked `provider: "<literal>"` pair, not the bare token —
    // `provider` appears elsewhere in generated output (metadata, embed calls).
    expect(out).not.toMatch(/provider:\s*"/);
  });

  it("bakes provider when defaultProvider is set", () => {
    const out = generate(PROGRAM, { client: { defaultProvider: "openrouter" } });
    expect(out).toMatch(/provider:\s*"openrouter"/);
  });
});
