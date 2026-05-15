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
    `tc-reserved-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
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

describe("reserved-name declaration check", () => {
  it("blocks `static const schema = 42`", () => {
    const errors = errorsFrom(`static const schema = 42\nnode main() { print(schema) }\n`);
    const reserved = errors.filter(
      (e) => e.message.includes("schema") && e.message.includes("reserved"),
    );
    expect(reserved).toHaveLength(1);
  });

  it("does not fire on substring matches like `static const schemaForX = 42`", () => {
    const errors = errorsFrom(
      `static const schemaForX = 42\nnode main() { print(schemaForX) }\n`,
    );
    const reserved = errors.filter(
      (e) => e.message.includes("schemaForX") && e.message.includes("reserved"),
    );
    expect(reserved).toHaveLength(0);
  });

  it("blocks `let interrupt = 5` inside a node body", () => {
    const errors = errorsFrom(`node main() { let interrupt = 5\n print(interrupt) }\n`);
    const reserved = errors.filter(
      (e) => e.message.includes("interrupt") && e.message.includes("reserved"),
    );
    expect(reserved).toHaveLength(1);
  });

  it("blocks `const success = 1` inside a function body", () => {
    const errors = errorsFrom(
      `def helper(): number { const success = 1\n return success }\n`,
    );
    const reserved = errors.filter(
      (e) => e.message.includes("success") && e.message.includes("reserved"),
    );
    expect(reserved).toHaveLength(1);
  });

  it("`def schema()` still errors (existing behavior unchanged)", () => {
    const errors = errorsFrom(`def schema(): number { return 1 }\n`);
    const reserved = errors.filter(
      (e) => e.message.includes("schema") && e.message.includes("reserved"),
    );
    expect(reserved.length).toBeGreaterThanOrEqual(1);
  });

  it("does not fire on `let s = schema(MyType)` (use, not declaration)", () => {
    const errors = errorsFrom(
      `type MyType = number\nnode main() { let s = schema(MyType)\n print(s) }\n`,
    );
    const reserved = errors.filter(
      (e) => e.message.includes("schema") && e.message.includes("reserved"),
    );
    expect(reserved).toHaveLength(0);
  });
});
