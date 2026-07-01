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
    `tc-builtinnamed-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, {});
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, {}, info).errors;
  } finally {
    unlinkSync(file);
  }
}

describe("builtin named-arg validation (fork/race shared:)", () => {
  it("accepts shared: true on fork", () => {
    const errors = errorsFrom(
      `node main() { let r = fork([1, 2], shared: true) as _ { return 1 }\n print(r) }`,
    );
    expect(errors).toHaveLength(0);
  });

  it("accepts shared: false on race", () => {
    const errors = errorsFrom(
      `node main() { let r = race([1, 2], shared: false) as _ { return 1 }\n print(r) }`,
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects unknown named arg on fork", () => {
    const errors = errorsFrom(
      `node main() { let r = fork([1, 2], shore: true) as _ { return 1 }\n print(r) }`,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /shore/.test(e.message))).toBe(true);
  });

  it("rejects duplicate named arg on fork (Copilot #3)", () => {
    const errors = errorsFrom(
      `node main() { let r = fork([1, 2], shared: true, shared: false) as _ { return 1 }\n print(r) }`,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) => /duplicate/i.test(e.message) && /shared/.test(e.message)),
    ).toBe(true);
  });

  it("rejects duplicate named arg on race (Copilot #3)", () => {
    const errors = errorsFrom(
      `node main() { let r = race([1, 2], shared: true, shared: true) as _ { return 1 }\n print(r) }`,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) => /duplicate/i.test(e.message) && /shared/.test(e.message)),
    ).toBe(true);
  });

  it("rejects non-boolean shared: value on fork (Copilot #4)", () => {
    const errors = errorsFrom(
      `node main() { let r = fork([1, 2], shared: "yes") as _ { return 1 }\n print(r) }`,
    );
    expect(errors.length).toBeGreaterThan(0);
    // Should mention the expected type
    expect(errors.some((e) => /boolean/i.test(e.message))).toBe(true);
  });

  it("rejects non-boolean shared: value on race (Copilot #4)", () => {
    const errors = errorsFrom(
      `node main() { let r = race([1, 2], shared: 42) as _ { return 1 }\n print(r) }`,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /boolean/i.test(e.message))).toBe(true);
  });
});

describe("builtin named-arg validation (llm options)", () => {
  it("accepts a known option as a named arg", () => {
    const errors = errorsFrom(
      `node main() { let r = llm("hi", model: "gpt-4o-mini")\n print(r) }`,
    );
    expect(errors).toHaveLength(0);
  });

  it("accepts several known options as named args", () => {
    const errors = errorsFrom(
      `node main() { let r = llm("hi", model: "gpt-4o-mini", maxTokens: 50, memory: true)\n print(r) }`,
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects an unknown option named arg", () => {
    const errors = errorsFrom(
      `node main() { let r = llm("hi", modle: "gpt-4o-mini")\n print(r) }`,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /modle/.test(e.message))).toBe(true);
  });

  it("rejects a wrongly-typed option named arg", () => {
    const errors = errorsFrom(
      `node main() { let r = llm("hi", maxTokens: "big")\n print(r) }`,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /number/i.test(e.message))).toBe(true);
  });
});
