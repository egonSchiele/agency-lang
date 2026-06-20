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

describe("AgencyFunction methods — .rename() type checking", () => {
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
    expect(
      errs.some(
        (e) =>
          e.includes(".rename()") &&
          e.includes("not assignable to parameter type 'string'"),
      ),
    ).toBe(true);
  });

  it("rejects the wrong number of arguments", () => {
    const errs = check(`
def add(a: number): number { return a }
def main() {
  const t = add.rename("a", "b")
}
`);
    expect(
      errs.some((e) => e.includes("Method '.rename()' expects 1 argument(s), got 2")),
    ).toBe(true);
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

// describe/preapprove share the same declarative-signature path as rename
// (AGENCY_FUNCTION_METHOD_TYPES in builtins.ts), so the typechecker validates
// them generically. These lock in that behavior.
describe(".describe() / .preapprove() type checking", () => {
  it("describe accepts a string and rejects a non-string", () => {
    const ok = check(`
def add(a: number): number { return a }
def main() { const t = add.describe("does a thing") }
`);
    expect(ok.filter((e) => e.includes("describe"))).toEqual([]);

    const bad = check(`
def add(a: number): number { return a }
def main() { const t = add.describe(5) }
`);
    expect(
      bad.some(
        (e) =>
          e.includes(".describe()") &&
          e.includes("not assignable to parameter type 'string'"),
      ),
    ).toBe(true);
  });

  it("preapprove takes no arguments", () => {
    const ok = check(`
def add(a: number): number { return a }
def main() { const t = add.preapprove() }
`);
    expect(ok.filter((e) => e.includes("preapprove"))).toEqual([]);

    const bad = check(`
def add(a: number): number { return a }
def main() { const t = add.preapprove("x") }
`);
    expect(
      bad.some((e) => e.includes("Method '.preapprove()' expects 0 argument(s), got 1")),
    ).toBe(true);
  });
});
