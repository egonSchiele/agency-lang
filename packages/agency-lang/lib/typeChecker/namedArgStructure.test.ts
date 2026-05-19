import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function errorsFrom(source: string): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-args-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed: " + parseResult.message);
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    const { errors } = typeCheck(program, {}, info);
    return errors.filter((e) => e.severity !== "warning");
  } finally {
    unlinkSync(file);
  }
}

describe("named-argument structural checks", () => {
  it("accepts splats before any named arg", () => {
    const errors = errorsFrom(`
      def f(a: number, b: number, c: number): number { return a + b + c }
      node main() {
        let xs = [2, 3]
        f(1, ...xs)
      }
    `);
    expect(errors).toEqual([]);
  });

  it("rejects a splat that comes after a named arg", () => {
    const errors = errorsFrom(`
      def f(a: number, b: number, c: number): number { return a + b + c }
      node main() {
        let xs = [2, 3]
        f(a: 1, ...xs)
      }
    `);
    expect(errors.some((e) =>
      /Splat argument cannot follow a named argument/.test(e.message),
    )).toBe(true);
  });

  it("rejects a positional that comes after a named arg", () => {
    const errors = errorsFrom(`
      def f(a: number, b: number): number { return a + b }
      node main() {
        f(a: 1, 2)
      }
    `);
    expect(errors.some((e) =>
      /Positional argument cannot follow a named argument/.test(e.message),
    )).toBe(true);
  });

  it("accepts reordered named args", () => {
    const errors = errorsFrom(`
      def f(a: number, b: number): number { return a + b }
      node main() {
        f(b: 2, a: 1)
      }
    `);
    expect(errors).toEqual([]);
  });
});
