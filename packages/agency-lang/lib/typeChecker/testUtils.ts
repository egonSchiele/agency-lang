import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";
import type { AgencyConfig } from "../config.js";

/**
 * Run the full typecheck pipeline on a source string and return errors.
 * Goes through parse → SymbolTable.build → buildCompilationUnit → typeCheck
 * so `info` (CompilationUnit) is populated — without it `ctx.functionDefs`,
 * `ctx.nodeDefs`, and `ctx.getTypeAliases()` are empty and diagnostics that
 * read them would silently never fire.
 *
 * Writes to a temp .agency file because SymbolTable.build resolves imports
 * by path. The programs here import nothing, so os.tmpdir() is fine.
 */
export function typecheckSource(
  src: string,
  config: AgencyConfig = {},
): TypeCheckError[] {
  const parsed = parseAgency(src);
  if (!parsed.success) {
    throw new Error(`parse failed: ${(parsed as { message?: string }).message ?? "unknown"}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-tc-"));
  try {
    const file = path.join(dir, "main.agency");
    fs.writeFileSync(file, src);
    const symbols = SymbolTable.build(file, config);
    const info = buildCompilationUnit(parsed.result, symbols, file, src);
    return typeCheck(parsed.result, config, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function raisesErrors(src: string): TypeCheckError[] {
  return typecheckSource(src).filter((e) => /raises/.test(e.message));
}
