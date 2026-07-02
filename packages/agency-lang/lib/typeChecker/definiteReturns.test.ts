import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { AgencyConfig } from "../config.js";
import type { TypeCheckError } from "./types.js";

function check(src: string, config: AgencyConfig = {}): TypeCheckError[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-dr-"));
  try {
    const file = path.join(dir, "main.agency");
    fs.writeFileSync(file, src);
    const parsed = parseAgency(src);
    if (!parsed.success) throw new Error("parse failed");
    const symbols = SymbolTable.build(file);
    const info = buildCompilationUnit(parsed.result, symbols, file, src);
    return typeCheck(parsed.result, config, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DR = /^Not all code paths return a value in '/;
const drDiags = (src: string, config: AgencyConfig = {}) =>
  check(src, config).filter((e) => DR.test(e.message));
const misses = (src: string, config: AgencyConfig = {}) => drDiags(src, config).length > 0;

describe("definite-return checking", () => {
  it("flags a typed function that misses the else path", () => {
    expect(misses(`def f(x: number): number { if (x > 0) { return 1 } }`)).toBe(true);
  });

  it("flags a straight-line body with no return", () => {
    expect(misses(`def f(): number { let x = 1 }`)).toBe(true);
  });

  it("accepts if/else where both branches return", () => {
    expect(misses(`def f(x: number): number { if (x > 0) { return 1 } else { return 0 } }`)).toBe(false);
  });

  it("accepts a straight-line return", () => {
    expect(misses(`def f(): number { return 1 }`)).toBe(false);
  });

  it("accepts nested if/else where every leaf returns", () => {
    expect(
      misses(`def f(a: bool, b: bool): number {
  if (a) { if (b) { return 1 } else { return 2 } } else { return 3 }
}`),
    ).toBe(false);
  });

  // --- match-aware definite-return (the #386 safe-subset skip is gone) ---
  // Since match expressions (7eefd7c1), `return` in a statement-position arm is
  // a compile error and expression-arm returns are matchYield unwinds, so a
  // match can never itself return from the function. The flow terminal is
  // therefore exact for match-containing functions: what matters is whether the
  // statements AROUND the match return on every path.

  it("flags a conditional return after a statement match (genuine fall-through)", () => {
    expect(
      misses(`def f(x: string): number {
  let out = 0
  match (x) {
    "a" => out = 1
    _ => out = 2
  }
  if (x == "a") { return out }
}`),
    ).toBe(true);
  });

  it("flags a statement match with no trailing return", () => {
    expect(misses(`def f(x: string): number { match (x) { "a" => print("hi")  _ => print("no") } }`)).toBe(true);
  });

  it("flags a conditional return after a Result expression match (genuine fall-through)", () => {
    expect(
      misses(`def mk(): Result<number, string> { return success(1) }
def f(): number {
  let r = mk()
  let out = match (r) { success(v) => v  failure(e) => 0 }
  if (out > 0) { return out }
}`),
    ).toBe(true);
  });

  it("flags a conditional return after a boolean expression match (genuine fall-through)", () => {
    expect(
      misses(`def f(x: bool): number {
  const out = match (x) { true => 1  false => 2 }
  if (x) { return out }
}`),
    ).toBe(true);
  });

  it("accepts a returned match expression (literal arms)", () => {
    // `return match(...)` lowers to the match region + a real trailing return.
    expect(misses(`def f(x: bool): number { return match (x) { true => 1  false => 2 } }`)).toBe(false);
  });

  it("accepts a returned match expression (pattern arms — the old idiomatic Result tail)", () => {
    expect(
      misses(`def mk(): Result<number, string> { return success(1) }
def f(): number {
  let r = mk()
  return match (r) { success(v) => v  failure(e) => 0 }
}`),
    ).toBe(false);
  });

  it("accepts an expression match with a block arm followed by an unconditional return", () => {
    // The mid-arm `return 1` is a matchYield (yields to the match), NOT a
    // function return — the function's own return is the trailing statement.
    expect(
      misses(`def f(x: bool): number {
  const out = match (x) {
    true => {
      print("t")
      return 1
    }
    false => 2
  }
  return out
}`),
    ).toBe(false);
  });

  it("accepts a statement match followed by an unconditional return", () => {
    expect(
      misses(`def f(x: string): number {
  let out = 0
  match (x) {
    "a" => out = 1
    _ => out = 2
  }
  return out
}`),
    ).toBe(false);
  });

  it("a matchYield is not a function return: expression match as the last statement still flags", () => {
    // Every arm "returns" (yields), but the match value is assigned and the
    // function then falls through.
    expect(
      misses(`def f(x: bool): number { const out = match (x) { true => { return 1 }  false => 2 } }`),
    ).toBe(true);
  });

  it("accepts return match with a block-arm mid-yield", () => {
    // Pins that the returned-match form stays exit even when an arm body is a
    // block whose yield is mid-arm (protects against a future flowBuilder
    // change to arm-body threading).
    expect(
      misses(`def f(x: bool): number {
  return match (x) {
    true => {
      print("t")
      return 1
    }
    false => 0
  }
}`),
    ).toBe(false);
  });

  it("exempts a function with no declared return type", () => {
    expect(misses(`def f(x: number) { if (x > 0) { return 1 } }`)).toBe(false);
  });

  it("exempts a void return type", () => {
    expect(misses(`def f(x: number): void { if (x > 0) { return } }`)).toBe(false);
  });

  it("exempts a never return type", () => {
    // `never` means "does not return normally"; not this check's concern.
    expect(misses(`effect e::x { }\ndef f(): never { raise e::x("m", {}) }`)).toBe(false);
  });

  it("exempts nodes", () => {
    expect(misses(`node main() { let x = 1 }`)).toBe(false);
  });

  it("flags a trailing raise with no return (documented: raise may resume)", () => {
    expect(misses(`effect e::x { }\ndef f(): number { raise e::x("m", {}) }`)).toBe(true);
  });

  it("checks each function independently (both offenders reported)", () => {
    const src = `def f(x: number): number { if (x > 0) { return 1 } }
def g(x: number): number { if (x > 0) { return 2 } }`;
    expect(drDiags(src).length).toBe(2);
  });

  // --- documented limitations, pinned ---
  it("LIMITATION: an infinite loop is flagged (flow model has no exit for while(true))", () => {
    expect(misses(`def f(): number { while (true) { let x = 1 } }`)).toBe(true);
  });

  // --- config knob ---
  it("silent suppresses the diagnostic", () => {
    expect(misses(`def f(): number { let x = 1 }`, { typechecker: { definiteReturns: "silent" } })).toBe(false);
  });

  it("warn demotes to a warning", () => {
    const d = drDiags(`def f(): number { let x = 1 }`, { typechecker: { definiteReturns: "warn" } });
    expect(d.length).toBe(1);
    expect(d[0].severity).toBe("warning");
  });

  it("error emits a hard error", () => {
    const d = drDiags(`def f(): number { let x = 1 }`, { typechecker: { definiteReturns: "error" } });
    expect(d.length).toBe(1);
    expect(d[0].severity ?? "error").toBe("error");
  });
});
