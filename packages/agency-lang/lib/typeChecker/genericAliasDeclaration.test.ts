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
    `tc-generic-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
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

describe("generic alias declaration validation", () => {
  it("accepts a body that references its declared type param", () => {
    const src = `
type Container<T> = { value: T }

node main() {
  let c: Container<number> = { value: 42 }
  print(c.value)
}
`;
    expect(errorsFrom(src)).toEqual([]);
  });

  it("flags a body that references an undeclared type-param-like identifier", () => {
    const src = `
type Container<T> = { value: U }
`;
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /not defined/.test(e.message))).toBe(true);
  });

  it("flags a required param appearing after a defaulted one", () => {
    const src = `
type Pair<A = string, B> = { first: A, second: B }
`;
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThan(0);
    expect(
      errs.some((e) =>
        /must come before parameters that have defaults/.test(e.message),
      ),
    ).toBe(true);
  });

  it("accepts an all-defaulted parameter list", () => {
    const src = `
type StringMap<V = any> = Record<string, V>

node main() {
  let r: StringMap = {}
  print(r)
}
`;
    expect(errorsFrom(src)).toEqual([]);
  });

  it("accepts defaults after required (correct ordering)", () => {
    const src = `
type Pair<A, B = string> = { first: A, second: B }
`;
    expect(errorsFrom(src)).toEqual([]);
  });
});
