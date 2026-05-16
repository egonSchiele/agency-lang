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
    `tc-primmembers-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
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

const propMissing = (e: TypeCheckError) => /Property .* does not exist/.test(e.message);
const arityErr = (e: TypeCheckError) => /expects .* argument/.test(e.message);
const typeErr = (e: TypeCheckError) => /not assignable to parameter type/.test(e.message);

describe("primitive members — string", () => {
  it("accepts s.length without error", () => {
    const errors = errorsFrom(
      `node main() { let s = "hi"\n let n = s.length\n print(n) }`,
    );
    expect(errors.filter(propMissing)).toHaveLength(0);
  });

  it("accepts s.toUpperCase()", () => {
    const errors = errorsFrom(
      `node main() { let s = "hi"\n let u = s.toUpperCase()\n print(u) }`,
    );
    expect(errors.filter(propMissing)).toHaveLength(0);
    expect(errors.filter(arityErr)).toHaveLength(0);
  });

  it("threads .length's number type through to a typed param", () => {
    const errors = errorsFrom(
      `def expectNum(n: number): number { return n }\n` +
        `node main() { let s = "hi"\n expectNum(s.length) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("rejects passing s.toUpperCase() (string) to a number param", () => {
    const errors = errorsFrom(
      `def expectNum(n: number): number { return n }\n` +
        `node main() { let s = "hi"\n expectNum(s.toUpperCase()) }\n`,
    );
    expect(errors.some((e) => e.message.includes("not assignable"))).toBe(true);
  });

  it("rejects s.indexOf with no args (arity)", () => {
    const errors = errorsFrom(
      `node main() { let s = "hi"\n let i = s.indexOf() }`,
    );
    expect(errors.filter(arityErr).length).toBeGreaterThan(0);
  });

  it("rejects s.indexOf with a number arg (type)", () => {
    const errors = errorsFrom(
      `node main() { let s = "hi"\n let i = s.indexOf(42) }`,
    );
    expect(errors.filter(typeErr).length).toBeGreaterThan(0);
  });

  it("accepts s.includes(\"x\") and threads boolean through", () => {
    const errors = errorsFrom(
      `def expectBool(b: boolean): boolean { return b }\n` +
        `node main() { let s = "hi"\n expectBool(s.includes("h")) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("accepts s.split(\",\") returning string[]", () => {
    const errors = errorsFrom(
      `def expectStrs(xs: string[]): string[] { return xs }\n` +
        `node main() { let s = "a,b,c"\n expectStrs(s.split(",")) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("rejects unknown member s.bogus", () => {
    const errors = errorsFrom(
      `node main() { let s = "hi"\n print(s.bogus) }`,
    );
    expect(errors.some((e) => e.message.includes("'bogus'"))).toBe(true);
  });
});

describe("primitive members — array", () => {
  it("accepts xs.length", () => {
    const errors = errorsFrom(
      `node main() { let xs = [1, 2, 3]\n print(xs.length) }`,
    );
    expect(errors.filter(propMissing)).toHaveLength(0);
  });

  it("threads xs.length through to number param", () => {
    const errors = errorsFrom(
      `def expectNum(n: number): number { return n }\n` +
        `node main() { let xs = [1, 2, 3]\n expectNum(xs.length) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.indexOf accepts an element-typed arg", () => {
    const errors = errorsFrom(
      `node main() { let xs = [1, 2, 3]\n let i = xs.indexOf(2)\n print(i) }`,
    );
    expect(errors.filter(arityErr)).toHaveLength(0);
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.indexOf rejects a wrong-type arg", () => {
    const errors = errorsFrom(
      `node main() { let xs = [1, 2, 3]\n let i = xs.indexOf("a") }`,
    );
    expect(errors.filter(typeErr).length).toBeGreaterThan(0);
  });

  it("xs.slice() returns the same Array<T>", () => {
    const errors = errorsFrom(
      `def expectNums(ns: number[]): number[] { return ns }\n` +
        `node main() { let xs = [1, 2, 3]\n expectNums(xs.slice(1)) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.join() returns string", () => {
    const errors = errorsFrom(
      `def expectStr(s: string): string { return s }\n` +
        `node main() { let xs = ["a", "b"]\n expectStr(xs.join(",")) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("rejects unknown member xs.bogus", () => {
    const errors = errorsFrom(
      `node main() { let xs = [1, 2, 3]\n print(xs.bogus) }`,
    );
    expect(errors.some((e) => e.message.includes("'bogus'"))).toBe(true);
  });
});

describe("primitive members — array callback methods (Phase 2)", () => {
  it("xs.map(\\(x) -> x + 1) returns number[]", () => {
    const errors = errorsFrom(
      `def expectNums(ns: number[]): number[] { return ns }\n` +
        `node main() { let xs = [1, 2, 3]\n expectNums(xs.map(\\(x) -> x + 1)) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.map narrows element type for body member access", () => {
    // x is bound to the element type — { name: string }, so x.name synths
    // to string and the resulting array is string[].
    const errors = errorsFrom(
      `def expectStrs(ss: string[]): string[] { return ss }\n` +
        `node main() {\n` +
        `  let xs = [{ name: "a" }, { name: "b" }]\n` +
        `  expectStrs(xs.map(\\(x) -> x.name))\n` +
        `}\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
    expect(errors.filter(propMissing)).toHaveLength(0);
  });

  it("xs.filter returns same Array<T>", () => {
    const errors = errorsFrom(
      `def expectNums(ns: number[]): number[] { return ns }\n` +
        `node main() { let xs = [1, 2, 3]\n expectNums(xs.filter(\\(x) -> x > 1)) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.find returns T | undefined", () => {
    // Assigning find's result directly to a `number` param should fail —
    // the result includes undefined.
    const errors = errorsFrom(
      `def expectNum(n: number): number { return n }\n` +
        `node main() { let xs = [1, 2, 3]\n expectNum(xs.find(\\(x) -> x > 1)) }\n`,
    );
    expect(errors.filter(typeErr).length).toBeGreaterThan(0);
  });

  it("xs.some returns boolean", () => {
    const errors = errorsFrom(
      `def expectBool(b: boolean): boolean { return b }\n` +
        `node main() { let xs = [1, 2, 3]\n expectBool(xs.some(\\(x) -> x > 1)) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.every returns boolean", () => {
    const errors = errorsFrom(
      `def expectBool(b: boolean): boolean { return b }\n` +
        `node main() { let xs = [1, 2, 3]\n expectBool(xs.every(\\(x) -> x > 0)) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.flatMap unwraps Array<U> to U[]", () => {
    const errors = errorsFrom(
      `def expectNums(ns: number[]): number[] { return ns }\n` +
        `node main() { let xs = [1, 2, 3]\n expectNums(xs.flatMap(\\(x) -> [x, x])) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.reduce uses the initializer's type", () => {
    const errors = errorsFrom(
      `def expectNum(n: number): number { return n }\n` +
        `node main() { let xs = [1, 2, 3]\n expectNum(xs.reduce(\\(acc, x) -> acc + x, 0)) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("xs.map(fnRef) infers from the function's return type", () => {
    const errors = errorsFrom(
      `def double(x: number): number { return x * 2 }\n` +
        `def expectNums(ns: number[]): number[] { return ns }\n` +
        `node main() { let xs = [1, 2, 3]\n expectNums(xs.map(double)) }\n`,
    );
    expect(errors.filter(typeErr)).toHaveLength(0);
  });

  it("does not leak block params into outer scope", () => {
    // After the .map block, `x` should not be defined in the outer scope.
    // Enable the undefined-variable diagnostic explicitly (default is silent).
    const errors = errorsFrom(
      `node main() {\n` +
        `  let xs = [1, 2, 3]\n` +
        `  let _ys = xs.map(\\(x) -> x + 1)\n` +
        `  print(x)\n` +
        `}\n`,
      { typechecker: { undefinedVariables: "warn" } },
    );
    expect(
      errors.some((e) => /Variable 'x' is not defined/.test(e.message)),
    ).toBe(true);
  });
});
