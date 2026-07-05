import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

// `if <c> then <a> else <b>` is a conditional EXPRESSION (compiles to a ternary)
// typed as the widened union of its two branches — the same rule a two-arm
// `match` expression uses.
describe("if expressions — typing", () => {
  it("checked position: annotation mismatch errors", () => {
    const errs = check(`node main(): number {
  const c = true
  const n: number = if c then "a" else "b"
  return n
}`);
    expect(errs.some((e) => /not assignable/.test(e) && /number/.test(e))).toBe(true);
  });

  it("compatible annotation: no errors", () => {
    const errs = check(`node main(): string {
  const c = true
  const label: string = if c then "a" else "b"
  return label
}`);
    expect(errs).toEqual([]);
  });

  it("synthesis: the branch union flows downstream", () => {
    const errs = check(`node main(): boolean {
  const c = true
  const x = if c then 1 else "two"
  const b: boolean = x
  return b
}`);
    expect(errs.some((e) => /number/.test(e) && /string/.test(e))).toBe(true);
    expect(errs.some((e) => /boolean/.test(e))).toBe(true);
  });

  it("usable as an object value", () => {
    const errs = check(`node main(age: number): string {
  const person = { kind: if age > 18 then "adult" else "child" }
  return person.kind
}`);
    expect(errs).toEqual([]);
  });
});

describe("if expressions — flatness restriction", () => {
  it("a nested if in a branch is an error", () => {
    const errs = check(`node main(a: boolean, b: boolean): string {
  const x = if a then (if b then "x" else "y") else "z"
  return x
}`);
    expect(errs.some((e) => /nested `if/.test(e))).toBe(true);
  });

  it("an `else if` chain is an error", () => {
    const errs = check(`node main(a: boolean, b: boolean): string {
  const x = if a then "x" else if b then "y" else "z"
  return x
}`);
    expect(errs.some((e) => /nested `if/.test(e) || /else if/.test(e))).toBe(true);
  });

  it("a nested if in the condition is an error", () => {
    const errs = check(`node main(a: boolean, b: boolean): string {
  const x = if (if a then b else a) then "x" else "z"
  return x
}`);
    expect(errs.some((e) => /nested `if/.test(e))).toBe(true);
  });

  it("an if expression cannot be spread into an object", () => {
    const errs = check(`node main(c: boolean): string {
  const a = { x: 1 }
  const b = { y: 2 }
  const merged = { ...(if c then a else b) }
  return "done"
}`);
    expect(errs.some((e) => /cannot be spread/.test(e))).toBe(true);
  });
});
