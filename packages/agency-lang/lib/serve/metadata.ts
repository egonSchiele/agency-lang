import fs from "fs";
import path from "path";
import process from "process";
import type { AgencyConfig } from "../config.js";
import { SymbolTable } from "../symbolTable.js";
import type { InterruptEffect } from "../symbolTable.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "../typeChecker/index.js";

export type ServeMetadata = {
  /** Same derivation as the compiler stamps onto `fn.module`; pass this to
   *  createServeHandler so discoverExports's module filter matches. */
  moduleId: string;
  exportedNodeNames: string[];
  interruptEffectsByName: Record<string, InterruptEffect[]>;
  /** Type-check diagnostics; the caller may format or ignore them. */
  errors: ReturnType<typeof typeCheck>["errors"];
};

/**
 * Compute the serve metadata for an Agency file: its exported node names, the
 * interrupt effects each function/node may raise, and the moduleId the
 * compiler will stamp. Pure with respect to disk output (no compiled JS is
 * written). Extracted from `compileForServe` so both share one derivation.
 */
export function collectServeMetadata({
  filePath,
  config,
}: {
  filePath: string;
  config: AgencyConfig;
}): ServeMetadata {
  const absoluteFile = path.resolve(filePath);
  const symbolTable = SymbolTable.build(absoluteFile, config);

  const fileSymbols = symbolTable.getFile(absoluteFile);
  const exportedNodeNames = Object.values(fileSymbols ?? {})
    .filter((sym) => sym.kind === "node" && sym.exported)
    .map((sym) => sym.name);

  const source = fs.readFileSync(absoluteFile, "utf-8");
  const parseResult = parseAgency(source, config);

  const interruptEffectsByName: Record<string, InterruptEffect[]> = {};
  let errors: ReturnType<typeof typeCheck>["errors"] = [];
  if (parseResult.success) {
    const info = buildCompilationUnit(parseResult.result, symbolTable, absoluteFile, source);
    const result = typeCheck(parseResult.result, config, info);
    errors = result.errors;
    Object.assign(interruptEffectsByName, result.interruptEffectsByFunction);
  }

  const moduleId = path.relative(process.cwd(), absoluteFile);
  return { moduleId, exportedNodeNames, interruptEffectsByName, errors };
}
