import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";
import { SymbolTable } from "../symbolTable.js";
import type { FileSymbols } from "../symbolTable.js";
import { existsSync, readFileSync } from "fs";
import { validatePolicy } from "../runtime/policy.js";
import path from "path";

function uniqueInterruptKinds(fileSymbols: FileSymbols | undefined): string[] {
  const kinds = Object.values(fileSymbols ?? {})
    .flatMap((sym) =>
      (sym.kind === "function" || sym.kind === "node") && sym.interruptKinds
        ? sym.interruptKinds.map((ik) => ik.kind)
        : [],
    );
  return [...new Set(kinds)];
}

export function policyGen(
  config: AgencyConfig,
  file: string,
  options: { output?: string; existing?: string },
): void {
  const absoluteFile = path.resolve(file);
  if (!existsSync(absoluteFile)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const outputPath = path.resolve(options.output ?? "policy.json");
  if (existsSync(outputPath) && outputPath !== path.resolve(options.existing ?? "")) {
    console.error(`Output file already exists: ${outputPath}. Use -p to edit an existing policy, or -o to specify a different output path.`);
    process.exit(1);
  }

  const symbolTable = SymbolTable.build(absoluteFile, config);
  const fileSymbols = symbolTable.getFile(absoluteFile);
  const interruptKinds = uniqueInterruptKinds(fileSymbols);

  if (interruptKinds.length === 0) {
    console.log("No interrupt kinds found in this agent. No policy needed.");
    return;
  }

  let existingPolicyJson = "";
  if (options.existing) {
    const existingPath = path.resolve(options.existing);
    if (!existsSync(existingPath)) {
      console.error(`Existing policy file not found: ${options.existing}`);
      process.exit(1);
    }
    existingPolicyJson = readFileSync(existingPath, "utf-8");
    const result = validatePolicy(JSON.parse(existingPolicyJson));
    if (!result.success) {
      console.error(`Invalid existing policy: ${result.error}`);
      process.exit(1);
    }
  }

  const agentArgs = [
    JSON.stringify(interruptKinds),
    outputPath,
    ...(existingPolicyJson ? [existingPolicyJson] : []),
  ];

  runBundledAgent(config, "policy", agentArgs);
}
