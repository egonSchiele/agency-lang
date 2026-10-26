import { describe, expect, it } from "vitest";
import { typecheckSource } from "./testUtils.js";
import type { AgencyConfig } from "../config/config.js";

const STRICT_NAMES: AgencyConfig = {
  typechecker: { undefinedVariables: "error", undefinedFunctions: "error" },
};

const HELPERS = `
def apply(block: () -> number): number { return block() }
def identity(value: number): number { return value }
`;

function check(source: string) {
  return typecheckSource(HELPERS + source, STRICT_NAMES);
}

describe("scope collection inside expression blocks", () => {
  it.each([
    [
      "an assignment",
      `const result = apply() { const local = 3; return local }
       return result`,
      "number",
    ],
    ["a return", "return apply() { const local = 3; return local }", "number"],
    ["an argument", "return identity(apply() { const local = 3; return local })", "number"],
    ["a pipe", "return apply() { const local = 3; return local } |> identity", "Result<number>"],
  ])("resolves local declarations in %s", (_, body, returnType) => {
    expect(check(`def main(): ${returnType} { ${body} }`)).toEqual([]);
  });

  it("resolves a callable local inside a returned block", () => {
    expect(
      check(`
def add(a: number, b: number): number { return a + b }
def main(): number {
  return apply() {
    const plusOne = add.partial(a: 1)
    return plusOne(2)
  }
}
`),
    ).toEqual([]);
  });

  it("still reports missing names inside a block", () => {
    const errors = check(`
def main(): number {
  return apply() {
    const local = 3
    missingCall(local)
    return missingValue
  }
}
`);
    expect(errors.map((error) => [error.name, error.message])).toEqual([
      ["undefinedFunction", expect.stringContaining("'missingCall'")],
      ["undefinedVariable", expect.stringContaining("'missingValue'")],
    ]);
  });

  it("reports each const reassignment and mutation once", () => {
    const errors = check(`
def main(): number {
  const result = apply() {
    const assigned = 1
    assigned = 2
    return assigned
  }
  return apply() {
    const incremented = result
    incremented++
    return incremented
  }
}
`);
    expect(errors.map((error) => [error.name, error.message])).toEqual([
      ["reassignToConst", expect.stringContaining("'assigned'")],
      ["reassignToConst", expect.stringContaining("'incremented'")],
    ]);
  });

  it("keeps block locals inside their enclosing function", () => {
    const errors = check(`
def owner(): number {
  return apply() { const local = 3; return local }
}
def other(): number { return local }
const outside = local
`);
    expect(errors.map((error) => [error.name, error.message])).toEqual([
      ["undefinedVariable", expect.stringContaining("'local'")],
      ["undefinedVariable", expect.stringContaining("'local'")],
    ]);
  });

  it("keeps inline callback parameters inside the callback", () => {
    const errors = check(`
def main(): number {
  const values = [1, 2].map(\\(item) -> item + 1)
  return item
}
`);
    expect(errors.map((error) => [error.name, error.message])).toEqual([
      ["undefinedVariable", expect.stringContaining("'item'")],
    ]);
  });

  it("preserves parameter typing for statement-position inline callbacks", () => {
    const errors = check(`
def each(cb: (number) -> void): void { cb(1) }
def main(): void { each(\\(item) -> item) }
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("number");
    expect(errors[0].message).toContain("void");
    expect(errors[0].message).toContain("block return");
  });
});
