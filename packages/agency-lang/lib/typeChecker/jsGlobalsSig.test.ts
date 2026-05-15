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
    `tc-jsglobals-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
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
const typeErr = (e: TypeCheckError) => /not assignable to parameter type/.test(e.message);

describe("JS_GLOBALS — flat callable sigs", () => {
  it("accepts parseInt with one string arg", () => {
    const errors = errorsFrom(`node main() { let n = parseInt("42") }`);
    expect(errors.filter(arityErr)).toHaveLength(0);
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("accepts parseInt with optional radix", () => {
    const errors = errorsFrom(`node main() { let n = parseInt("ff", 16) }`);
    expect(errors.filter(arityErr)).toHaveLength(0);
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("rejects parseInt with a boolean", () => {
    const errors = errorsFrom(`node main() { let n = parseInt(true) }`);
    expect(errors.filter(typeErr).length).toBeGreaterThan(0);
  });

  it("rejects parseInt with three args", () => {
    const errors = errorsFrom(`node main() { let n = parseInt("1", 2, 3) }`);
    expect(errors.filter(arityErr).length).toBeGreaterThan(0);
  });

  it("infers parseInt's return type as number", () => {
    const errors = errorsFrom(
      `def expectNum(n: number): number { return n }\nnode main() { expectNum(parseInt("1")) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });
});

describe("JS_GLOBALS — namespace member sigs", () => {
  it("accepts JSON.parse with one string arg", () => {
    const errors = errorsFrom(`node main() { let x = JSON.parse("{}") }`);
    expect(errors.filter(arityErr)).toHaveLength(0);
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("rejects JSON.parse with no args", () => {
    const errors = errorsFrom(`node main() { let x = JSON.parse() }`);
    expect(errors.filter(arityErr).length).toBeGreaterThan(0);
  });

  it("rejects JSON.parse with two args", () => {
    const errors = errorsFrom(`node main() { let x = JSON.parse("{}", "{}") }`);
    expect(errors.filter(arityErr).length).toBeGreaterThan(0);
  });

  it("rejects Math.floor with a non-number", () => {
    const errors = errorsFrom(`node main() { let n = Math.floor("hi") }`);
    expect(errors.filter(typeErr).length).toBeGreaterThan(0);
  });

  it("accepts Math.floor with a number", () => {
    const errors = errorsFrom(`node main() { let n = Math.floor(3.7) }`);
    expect(errors.filter(arityErr)).toHaveLength(0);
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("accepts variadic Math.max with any number of args", () => {
    const errors = errorsFrom(`node main() { let n = Math.max(1, 2, 3, 4, 5) }`);
    expect(errors.filter(arityErr)).toHaveLength(0);
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("does not error on console.log with multiple args (no sig)", () => {
    const errors = errorsFrom(`node main() { console.log(1, 2, 3) }`);
    expect(errors.filter(arityErr)).toHaveLength(0);
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("does not validate when the namespace base is shadowed", () => {
    // `let JSON = ...` opts out of JS_GLOBALS validation entirely.
    const errors = errorsFrom(
      `node main() { let JSON = { parse: 1 }\n let x = JSON.parse }`,
    );
    expect(errors.filter(arityErr)).toHaveLength(0);
  });
});
