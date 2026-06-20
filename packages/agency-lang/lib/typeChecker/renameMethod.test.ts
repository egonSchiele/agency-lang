import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(
    parsed.result,
    { typechecker: { undefinedFunctions: "silent" } },
    info,
  ).errors.map((e) => e.message);
}

describe(".rename() type checking", () => {
  it("accepts a string literal argument", () => {
    const errs = check(`
def add(a: number): number { return a }
def main() {
  const t = add.rename("addTool")
}
`);
    expect(errs.filter((e) => e.includes("rename"))).toEqual([]);
  });

  it("accepts a string-valued call expression argument", () => {
    // This is the skillsDir pattern: .rename(skillToolName(dir)).
    const errs = check(`
def add(a: number): number { return a }
def name(): string { return "x" }
def main() {
  const t = add.rename(name())
}
`);
    expect(errs.filter((e) => e.includes("rename"))).toEqual([]);
  });

  it("rejects a non-string literal argument", () => {
    const errs = check(`
def add(a: number): number { return a }
def main() {
  const t = add.rename(5)
}
`);
    expect(errs.some((e) => e.includes("rename() argument must be a string"))).toBe(true);
  });

  it("rejects the wrong number of arguments", () => {
    const errs = check(`
def add(a: number): number { return a }
def main() {
  const t = add.rename("a", "b")
}
`);
    expect(errs.some((e) => e.includes("rename() requires exactly one string argument"))).toBe(true);
  });

  it("composes with partial and describe", () => {
    const errs = check(`
def add(a: number, b: number): number { return a + b }
def main() {
  const t = add.partial(a: 1).describe("adds one").rename("addOne")
}
`);
    expect(errs.filter((e) => e.includes("rename"))).toEqual([]);
  });
});
