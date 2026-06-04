/**
 * Spec 2026-06-03 Part 5.1: named-arg targeting variadic.
 *
 * These tests pin the *positive* behaviors of the new named-array calling
 * convention for variadic parameters AND the type-checker's rejection
 * surface for the new error cases. Each test asserts both the absence
 * of unrelated diagnostics and the presence of specific ones, so that
 * a regression which silently drops the check still fails.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function checkSource(source: string): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-vnb-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) {
      throw new Error("Parse failed: " + parseResult.message);
    }
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, {}, info).errors;
  } finally {
    unlinkSync(file);
  }
}

const errorsOnly = (es: TypeCheckError[]) => es.filter((e) => e.severity !== "warning");
const warningsOnly = (es: TypeCheckError[]) => es.filter((e) => e.severity === "warning");

describe("variadic named-arg binding (compile-time)", () => {
  // #1
  it("accepts foo(xs: [1,2,3]) for ...xs: number[]", () => {
    const diags = checkSource(`
      def foo(...xs: number[]): number { return 0 }
      node main() {
        foo(xs: [1, 2, 3])
      }
    `);
    expect(errorsOnly(diags)).toEqual([]);
    expect(warningsOnly(diags)).toEqual([]);
  });

  // #2
  it("accepts mixed positional + named variadic foo(1, rest: [2,3])", () => {
    const diags = checkSource(`
      def foo(a: number, ...rest: number[]): number { return a }
      node main() {
        foo(1, rest: [2, 3])
      }
    `);
    expect(errorsOnly(diags)).toEqual([]);
    expect(warningsOnly(diags)).toEqual([]);
  });

  // #3
  it("accepts pure named form with fixed param foo(a: 1, rest: [2,3])", () => {
    const diags = checkSource(`
      def foo(a: number, ...rest: number[]): number { return a }
      node main() {
        foo(a: 1, rest: [2, 3])
      }
    `);
    expect(errorsOnly(diags)).toEqual([]);
  });

  // #4
  it("rejects positional-after-named-variadic foo(1, 2, rest: [3])", () => {
    const diags = checkSource(`
      def foo(a: number, ...rest: number[]): number { return a }
      node main() {
        foo(1, 2, rest: [3])
      }
    `);
    const errs = errorsOnly(diags);
    expect(errs.length).toBeGreaterThanOrEqual(1);
    const match = errs.find(
      (e) =>
        e.message.includes("'rest'") &&
        e.message.includes("'foo'") &&
        /Positional argument cannot feed variadic/.test(e.message),
    );
    expect(match).toBeDefined();
    expect(match!.loc).toBeDefined();
  });

  // #5: wrong outer shape — passing a scalar to a variadic-by-name slot.
  it("rejects foo(rest: 5) for ...rest: number[] with assignability error", () => {
    const diags = checkSource(`
      def foo(...rest: number[]): number { return 0 }
      node main() {
        foo(rest: 5)
      }
    `);
    const errs = errorsOnly(diags);
    const a = errs.find((e) => /not assignable/.test(e.message));
    expect(a).toBeDefined();
    expect(a!.expectedType).toBe("number[]");
    expect(a!.actualType).toBe("number");
  });

  // #6: wrong element type. Use a typed const so the array's element type
  // synthesizes as `string[]`, not a union of string literals.
  it("rejects foo(rest: typedStrs) for ...rest: number[] with assignability error", () => {
    const diags = checkSource(`
      def foo(...rest: number[]): number { return 0 }
      node main() {
        let xs: string[] = ["a", "b"]
        foo(rest: xs)
      }
    `);
    const errs = errorsOnly(diags);
    const a = errs.find((e) => /not assignable/.test(e.message));
    expect(a).toBeDefined();
    expect(a!.expectedType).toBe("number[]");
    expect(a!.actualType).toBe("string[]");
  });

  // #7: right element, wrong nesting — proves the named slot is T[], not T.
  it("rejects foo(rest: [[1,2]]) for ...rest: number[]", () => {
    const diags = checkSource(`
      def foo(...rest: number[]): number { return 0 }
      node main() {
        foo(rest: [[1, 2]])
      }
    `);
    const errs = errorsOnly(diags);
    expect(errs.some((e) => /not assignable/.test(e.message))).toBe(true);
  });

  // #8: array-of-array variadic disambiguation.
  it("accepts foo(xs: [[1,2],[3]]) for ...xs: number[][]", () => {
    const diags = checkSource(`
      def foo(...xs: number[][]): number { return 0 }
      node main() {
        foo(xs: [[1, 2], [3]])
      }
    `);
    expect(errorsOnly(diags)).toEqual([]);
  });

  // #9: .partial() with named-array binds variadic; no legacy "cannot be bound" error.
  it("accepts foo.partial(rest: [1,2]) for ...rest: number[]", () => {
    const diags = checkSource(`
      def foo(...rest: number[]): number { return 0 }
      node main() {
        let bound = foo.partial(rest: [1, 2])
      }
    `);
    const errs = errorsOnly(diags);
    expect(errs.some((e) => /cannot be bound/.test(e.message))).toBe(false);
    expect(errs).toEqual([]);
  });

  // #10: .partial() with wrong array element type rejects.
  it("rejects foo.partial(rest: typedStrs) for ...rest: number[]", () => {
    const diags = checkSource(`
      def foo(...rest: number[]): number { return 0 }
      node main() {
        let xs: string[] = ["a"]
        let bound = foo.partial(rest: xs)
      }
    `);
    const errs = errorsOnly(diags);
    const a = errs.find((e) => /not assignable/.test(e.message));
    expect(a).toBeDefined();
    expect(a!.expectedType).toBe("number[]");
  });

  // #11: block-typed param still nameable as plain named arg (regression
  // guard for the paramListSignature refactor).
  it("still accepts block named arg foo(block: fn) for def foo(block: () => void)", () => {
    const diags = checkSource(`
      def cb(): void {}
      def foo(block: () => void): void { block() }
      node main() {
        foo(block: cb)
      }
    `);
    expect(errorsOnly(diags)).toEqual([]);
  });
});
