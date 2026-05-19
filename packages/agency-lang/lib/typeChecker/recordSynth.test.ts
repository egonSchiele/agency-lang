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

function errorsFrom(
  source: string,
  config: AgencyConfig = {},
): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-record-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, config);
    const parseResult = parseAgency(source, config);
    if (!parseResult.success)
      throw new Error("Parse failed: " + parseResult.message);
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, config, info).errors;
  } finally {
    unlinkSync(file);
  }
}

describe("synthesizer: Record property access", () => {
  it("typechecks bracket index access against value type", () => {
    const src = `
node main() {
  let votes: Record<string, string> = {}
  let v: string = votes["alice"]
}
`;
    expect(errorsFrom(src)).toEqual([]);
  });

  it("typechecks dot property access against value type", () => {
    const src = `
node main() {
  let votes: Record<string, number> = {}
  let v: number = votes.alice
}
`;
    expect(errorsFrom(src)).toEqual([]);
  });

  it("rejects assignment of wrong value type", () => {
    const src = `
node main() {
  let votes: Record<string, number> = {}
  let v: string = votes["alice"]
}
`;
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe("synthesizer: for-in over Record", () => {
  it("declares the iteration variable as the key type", () => {
    const src = `
node main() {
  let votes: Record<string, number> = {}
  for (k in votes) {
    let s: string = k
  }
}
`;
    expect(errorsFrom(src)).toEqual([]);
  });

  it("rejects when iteration variable is used as the wrong type", () => {
    const src = `
node main() {
  let votes: Record<string, number> = {}
  for (k in votes) {
    let n: number = k
  }
}
`;
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThan(0);
  });
});
