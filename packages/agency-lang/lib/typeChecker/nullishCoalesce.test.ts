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

describe("?? type synthesis", () => {
  it("strips undefined from a nullable LHS union", () => {
    // Before this fix, `??` fell through synthBinOp's switch and synthed as
    // `number`, so this assignment would incorrectly error with
    // "Type 'number' is not assignable to type 'string'".
    const errs = check(`
type S = { context: string | undefined }
def f(s: S): string {
  const out: string = s.context ?? ""
  return out
}
`);
    expect(errs).toEqual([]);
  });

  it("strips null from a nullable LHS union", () => {
    const errs = check(`
type S = { name: string | null }
def f(s: S): string {
  const out: string = s.name ?? "anon"
  return out
}
`);
    expect(errs).toEqual([]);
  });

  it("returns the LHS type when it is already non-nullable", () => {
    const errs = check(`
def f(): string {
  const x: string = "hello"
  const out: string = x ?? "fallback"
  return out
}
`);
    expect(errs).toEqual([]);
  });

  it("falls back to the RHS type when LHS is any", () => {
    const errs = check(`
def f(s: any): string {
  const out: string = s ?? ""
  return out
}
`);
    expect(errs).toEqual([]);
  });

  it("still rejects assigning a ?? result to an incompatible target type", () => {
    const errs = check(`
type S = { context: string | undefined }
def f(s: S): string {
  const out: number = s.context ?? ""
  return out
}
`);
    expect(
      errs.some((m) => m.includes("not assignable") && m.includes("number")),
    ).toBe(true);
  });
});
