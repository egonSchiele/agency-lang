import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";
import { SymbolTable } from "../symbolTable.js";
import type { FileSymbols, InterruptKind } from "../symbolTable.js";
import { existsSync, readFileSync } from "fs";
import { validatePolicy } from "../runtime/policy.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "../typeChecker/index.js";
import path from "path";

function uniqueInterruptKinds(
  fileSymbols: FileSymbols | undefined,
  interruptKindsByFunction: Record<string, InterruptKind[]>,
): string[] {
  // The symbol table only records *direct* interrupts (literal `interrupt`
  // statements in a function/node body). Transitive interrupts — e.g. a node
  // that calls `read()`, where `read` itself throws `std::read` — are computed
  // by the type checker. Merge both so the policy agent sees the full set.
  const kinds: string[] = [];
  for (const sym of Object.values(fileSymbols ?? {})) {
    if (sym.kind !== "function" && sym.kind !== "node") continue;
    const transitive = interruptKindsByFunction[sym.name] ?? sym.interruptKinds ?? [];
    for (const ik of transitive) {
      if (!kinds.includes(ik.kind)) kinds.push(ik.kind);
    }
  }
  return kinds;
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

  // Run the type checker so we get *transitive* interrupt kinds (the symbol
  // table only knows about direct `interrupt` statements; calls into stdlib
  // functions like `read()` need the type checker's transitive analysis).
  const source = readFileSync(absoluteFile, "utf-8");
  const parseResult = parseAgency(source, config);
  let interruptKindsByFunction: Record<string, InterruptKind[]> = {};
  if (parseResult.success) {
    const info = buildCompilationUnit(parseResult.result, symbolTable, absoluteFile, source);
    const result = typeCheck(parseResult.result, config, info);
    interruptKindsByFunction = result.interruptKindsByFunction;
  }
  const interruptKinds = uniqueInterruptKinds(fileSymbols, interruptKindsByFunction);

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
