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

// `if c then a else b` lowers to the same match-expression machinery, so it is
// typed as the widened union of its two branches (and its condition is checked
// as boolean, like a statement `if`).
describe("if-expression typing", () => {
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

  it("a non-boolean condition errors, like a statement `if`", () => {
    const errs = check(`node main(): string {
  const x = if 123 then "a" else "b"
  return x
}`);
    expect(errs.some((e) => /not assignable to type 'boolean'/.test(e))).toBe(true);
  });
});
