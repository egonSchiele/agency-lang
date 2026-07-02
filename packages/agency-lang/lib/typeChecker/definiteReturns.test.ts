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

  // SAFE SUBSET: functions that use a `match` are skipped for now (whether they
  // return on all paths depends on match exhaustiveness — deferred to a follow-up).
  it("skips a match-containing function that returns via a match expression", () => {
    expect(misses(`def f(x: string): number { return match (x) { "a" => 1  _ => 0 } }`)).toBe(false);
  });

  it("skips a match-containing function that does not return on all paths (no false positive)", () => {
    // A statement match with no trailing return: the function misses a return,
    // but is skipped because it contains a match.
    expect(misses(`def f(x: string): number { match (x) { "a" => print("hi")  _ => print("no") } }`)).toBe(false);
  });

  it("skips a function with a pattern match (idiomatic Result match, no `_`)", () => {
    // The false-positive case that drove the safe-subset decision: an exhaustive
    // Result match with no `_`. Must NOT be flagged.
    expect(
      misses(`def mk(): Result<number, string> { return success(1) }
def f(): number { let r = mk()\n return match (r) { success(v) => v  failure(e) => 0 } }`),
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

  it("skips a `_`-less match (safe subset — no false positive on exhaustive matches)", () => {
    // A boolean match over true/false is exhaustive and returns on all paths, but
    // the safe subset simply skips any match-containing function, so no diagnostic.
    expect(misses(`def f(x: bool): number { return match (x) { true => 1  false => 0 } }`)).toBe(false);
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
