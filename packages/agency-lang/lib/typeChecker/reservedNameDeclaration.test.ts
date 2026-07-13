import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { getStdlibDir } from "../importPaths.js";
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

  it("blocks `def callback(...)` at top level (auto-imported from std::index)", () => {
    const errors = errorsFrom(`def callback(x: any) { return x }\n`);
    const reserved = errors.filter(
      (e) => e.message.includes("callback") && e.message.includes("reserved"),
    );
    expect(reserved.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks `let callback = 5` inside a node body", () => {
    const errors = errorsFrom(`node main() { let callback = 5\n print(callback) }\n`);
    const reserved = errors.filter(
      (e) => e.message.includes("callback") && e.message.includes("reserved"),
    );
    expect(reserved).toHaveLength(1);
  });

  it("blocks `static const callback = 1` at top level", () => {
    const errors = errorsFrom(`static const callback = 1\nnode main() { print(callback) }\n`);
    const reserved = errors.filter(
      (e) => e.message.includes("callback") && e.message.includes("reserved"),
    );
    expect(reserved).toHaveLength(1);
  });

  // Regression: the non-templated stdlib prelude (`std::index`) is the
  // canonical *definition* site of these built-ins (e.g. `export def
  // callback(...)`), so it must be exempt from the reserved-name check.
  // Before the exemption, typechecking the prelude reported AG4002 against its
  // own `callback`, and because the prelude is auto-imported everywhere that
  // one error cascaded into every file's typecheck step (whole suite -> ~34%).
  it("exempts the stdlib prelude from the reserved-name check (its own builtins)", () => {
    const preludePath = path.join(getStdlibDir(), "index.agency");
    const source = readFileSync(preludePath, "utf-8");
    const parseResult = parseAgency(source, {});
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;
    const symbolTable = SymbolTable.build(preludePath, {});
    const info = buildCompilationUnit(
      parseResult.result,
      symbolTable,
      preludePath,
      source,
    );
    const errors = typeCheck(parseResult.result, {}, info).errors;
    const reserved = errors.filter((e) => e.message.includes("reserved built-in"));
    expect(reserved).toEqual([]);
  });
});
