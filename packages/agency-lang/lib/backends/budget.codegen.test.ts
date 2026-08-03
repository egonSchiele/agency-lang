import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

// Codegen wiring: agency.json `budget` must be baked into the generated
// `new RuntimeContext({...})` args, with maxTime resolved to milliseconds at
// compile time. installRootBudget reads it at runtime when no --max-cost /
// --max-time flag is set. (Served agents get the budget via runtime-config
// overrides instead — statelog compiles the uploaded source without this config.)
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

describe("budget codegen", () => {
  it("bakes budget.maxCost and resolves maxTime to milliseconds", () => {
    const out = generate(PROGRAM, { budget: { maxCost: 0.5, maxTime: "10m" } });
    expect(out).toContain("maxCost: 0.5");
    expect(out).toContain("maxTimeMs: 600000");
  });

  it("bakes maxCost alone (0 is a real limit) without maxTimeMs", () => {
    const out = generate(PROGRAM, { budget: { maxCost: 0 } });
    expect(out).toContain("maxCost: 0");
    expect(out).not.toContain("maxTimeMs");
  });

  it("omits budget entirely when not configured", () => {
    const out = generate(PROGRAM);
    expect(out).not.toContain("maxTimeMs");
    expect(out).not.toContain("budget:");
  });
});
