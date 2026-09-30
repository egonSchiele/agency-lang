import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config/config.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Remote logging must be opt-in: with no `log.host` or `client.statelog` in
// the config, the compiled program names no remote host at all, so a
// STATELOG_API_KEY in the environment cannot turn remote logging on.
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

// The config every program in this package is compiled with, including the
// agents and the standard library that ship to users.
const PACKAGE_CONFIG = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../agency.json", import.meta.url)), "utf-8"),
) as Partial<AgencyConfig>;

describe("statelog codegen", () => {
  it("the package's own config names no remote host", () => {
    expect(PACKAGE_CONFIG.log?.host).toBeUndefined();
    expect(PACKAGE_CONFIG.log?.projectId).toBeUndefined();
    expect(PACKAGE_CONFIG.client?.statelog).toBeUndefined();
    const out = generate(PROGRAM, PACKAGE_CONFIG);
    expect(out).not.toContain("https://");
    expect(out).not.toContain("STATELOG_SMOLTALK_API_KEY");
  });

  it("names no remote host when none is configured", () => {
    const out = generate(PROGRAM, { observability: true, log: { logFile: "log.jsonl" } });
    expect(out).not.toContain("https://");
    expect(out).toContain('host: ""');
  });

  it("leaves the smoltalk statelog config out when none is configured", () => {
    const out = generate(PROGRAM);
    expect(out).not.toContain("STATELOG_SMOLTALK_API_KEY");
  });

  it("leaves the smoltalk statelog config out when the project id is missing", () => {
    const out = generate(PROGRAM, {
      client: { statelog: { host: "https://logs.example.com" } },
    } as Partial<AgencyConfig>);
    expect(out).not.toContain("STATELOG_SMOLTALK_API_KEY");
    expect(out).not.toContain("https://logs.example.com");
  });

  it("emits the smoltalk statelog config when host and project id are set", () => {
    const out = generate(PROGRAM, {
      client: { statelog: { host: "https://logs.example.com", projectId: "llm-calls" } },
    } as Partial<AgencyConfig>);
    expect(out).toContain("STATELOG_SMOLTALK_API_KEY");
    expect(out).toContain('projectId: "llm-calls"');
  });
});
