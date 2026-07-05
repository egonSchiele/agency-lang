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

// `if` expressions lower to the same matchYield/matchExprId/matchExprSource
// machinery as `match` expressions, so union typing + assignability come for
// free. These lock that in.
describe("if expressions — union typing + assignability", () => {
  it("checked position: annotation mismatch errors per branch", () => {
    const errs = check(`node main(): number {
  const c = true
  const n: number = if (c) { "a" } else { "b" }
  return n
}`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /number/.test(e))).toBe(true);
  });

  it("compatible annotation: no errors", () => {
    const errs = check(`node main(): string {
  const c = true
  const label: string = if (c) { "a" } else { "b" }
  return label
}`);
    expect(errs).toEqual([]);
  });

  it("synthesis: the branch union flows to downstream uses", () => {
    const errs = check(`node main(): boolean {
  const c = true
  const x = if (c) { 1 } else { "two" }
  const b: boolean = x
  return b
}`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /number/.test(e) && /string/.test(e))).toBe(true);
    expect(errs.some((e) => /boolean/.test(e))).toBe(true);
  });

  it("else-if chain unions every branch", () => {
    const errs = check(`node main(x: number): boolean {
  const label = if (x == 0) { "z" } else if (x > 0) { "p" } else { 3 }
  const b: boolean = label
  return b
}`);
    // union is string | number, not assignable to boolean
    expect(errs.some((e) => /boolean/.test(e))).toBe(true);
  });

  it("return if-expression is checked against the declared return type", () => {
    const errs = check(`def f(x: boolean): number {
  return if (x) { "a" } else { "b" }
}
node main(): number { return f(true) }`);
    expect(errs.some((e) => /number/.test(e))).toBe(true);
  });
});
