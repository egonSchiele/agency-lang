import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";
import type { AgencyConfig } from "../config.js";

function errorsFrom(source: string, config: AgencyConfig = {}): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-arity-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, config);
    const parseResult = parseAgency(source, config);
    if (!parseResult.success) throw new Error("Parse failed");
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, config, info).errors;
  } finally {
    unlinkSync(file);
  }
}

const arityErr = (e: TypeCheckError) => /Expected .* argument/.test(e.message);

describe("BUILTIN_FUNCTION_TYPES — reserved callables", () => {
  it("approve accepts 0 or 1 args", () => {
    expect(errorsFrom(`node main() { approve() }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { approve(42) }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { approve(1, 2) }`).filter(arityErr).length).toBeGreaterThan(0);
  });

  it("reject accepts 0 or 1 args", () => {
    expect(errorsFrom(`node main() { reject() }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { reject(42) }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { reject(1, 2) }`).filter(arityErr).length).toBeGreaterThan(0);
  });

  it("propagate takes no args", () => {
    expect(errorsFrom(`node main() { propagate() }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { propagate(42) }`).filter(arityErr).length).toBeGreaterThan(0);
  });

  it("checkpoint takes no args", () => {
    expect(errorsFrom(`node main() { let id = checkpoint() }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { let id = checkpoint(1) }`).filter(arityErr).length).toBeGreaterThan(0);
  });

  it("getCheckpoint requires exactly 1 numeric arg", () => {
    expect(errorsFrom(`node main() { let v = getCheckpoint(1) }`).filter(arityErr)).toHaveLength(0);
    expect(errorsFrom(`node main() { let v = getCheckpoint() }`).filter(arityErr).length).toBeGreaterThan(0);
    expect(errorsFrom(`node main() { let v = getCheckpoint(1, 2) }`).filter(arityErr).length).toBeGreaterThan(0);
  });
});
