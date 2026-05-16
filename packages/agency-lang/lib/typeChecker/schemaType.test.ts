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
    `tc-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, config);
    const parseResult = parseAgency(source, config);
    if (!parseResult.success) throw new Error("Parse failed: " + parseResult.message);
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, config, info).errors;
  } finally {
    unlinkSync(file);
  }
}

describe("Schema<T> type synthesis", () => {
  it("`schema(MyType).parse(x)` synths to Result<MyType, any>", () => {
    // Assigning a Result to a non-Result number should fail.
    const errors = errorsFrom(
      [
        "type MyType = number",
        "node main() {",
        "  let s = schema(MyType)",
        "  let r: number = s.parse(42)",
        "}",
        "",
      ].join("\n"),
    );
    const mismatch = errors.filter(
      (e) => e.message.includes("Result") && e.message.includes("number"),
    );
    expect(mismatch.length).toBeGreaterThanOrEqual(1);
  });

  it("`schema(MyType).parse(x)` is assignable to a Result<MyType, any> binding", () => {
    const errors = errorsFrom(
      [
        "type MyType = number",
        "node main() {",
        "  let s = schema(MyType)",
        "  let r: Result<number, any> = s.parse(42)",
        "  print(r)",
        "}",
        "",
      ].join("\n"),
    );
    expect(errors.filter((e) => e.severity !== "warning")).toEqual([]);
  });

  it("`.parseJSON` on a schema also synths to Result<T, any>", () => {
    const errors = errorsFrom(
      [
        "type MyType = number",
        "node main() {",
        "  let s = schema(MyType)",
        '  let r: Result<number, any> = s.parseJSON("42")',
        "  print(r)",
        "}",
        "",
      ].join("\n"),
    );
    expect(errors.filter((e) => e.severity !== "warning")).toEqual([]);
  });

  it("an unknown method on a schema falls back to any (no false positives)", () => {
    const errors = errorsFrom(
      [
        "type MyType = number",
        "node main() {",
        "  let s = schema(MyType)",
        "  let r = s.somethingWeird(1)",
        "  print(r)",
        "}",
        "",
      ].join("\n"),
    );
    // Should not raise a type-mismatch error from synth (the method is
    // unknown, so currentType becomes "any" and downstream is silent).
    const mismatch = errors.filter(
      (e) => e.message.includes("not assignable"),
    );
    expect(mismatch).toEqual([]);
  });
});
