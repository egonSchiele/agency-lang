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

  describe("a name shared by a block parameter and another variable", () => {
    const TYPED_HELPERS = `
def onNum(cb: (number) -> number): number { return cb(1) }
def onStr(cb: (string) -> number): number { return cb("hello") }
`;

    it.each([
      ["two", ""],
      ["three", "const c = onStr() as x { return x.length }"],
    ])("accepts %s typed blocks that reuse a parameter name", (_, thirdBlock) => {
      const errors = typecheckSource(`${TYPED_HELPERS}
def main(): number {
  const a = onNum() as x { return x + 1 }
  const b = onStr() as x { return x.length }
  ${thirdBlock}
  return a + b
}
`);
      expect(errors).toEqual([]);
    });

    it.each([
      ["no annotation", "const x = 5"],
      ["an annotation", "const x: number = 5"],
    ])("accepts a later local with %s that reuses a block parameter name", (_, local) => {
      const errors = typecheckSource(`${TYPED_HELPERS}
def main(): number {
  const b = onStr() as x { return x.length }
  ${local}
  return b + x
}
`);
      expect(errors).toEqual([]);
    });

    // Blocks do not have scopes of their own yet, so the function parameter
    // and the block parameter share one binding, and it becomes `any`. That
    // also hides the real mistake on the `const s` line. Block-aware scopes
    // would report it, and this test should change when they land.
    it("makes a function parameter that a block parameter reuses `any`", () => {
      const errors = typecheckSource(`${TYPED_HELPERS}
def main(x: number): number {
  const b = onStr() as x { return x.length }
  const s: string = x
  return b
}
`);
      expect(errors).toEqual([]);
    });

    it.each([
      ["before", "const x = 1\n  const b = onNum() as x { x = x + 1; return x }"],
      ["after", "const b = onNum() as x { x = x + 1; return x }\n  const x = 1"],
    ])("lets a block reassign a parameter named like a const declared %s it", (_, body) => {
      const errors = typecheckSource(`${TYPED_HELPERS}
def main(): number {
  ${body}
  return b
}
`);
      expect(errors).toEqual([]);
    });
  });

  it("resolves locals in a thread used as a value", () => {
    expect(
      check(`
def main(): number {
  const messages = thread {
    const local = 3
    identity(local)
  }
  return 0
}
`),
    ).toEqual([]);
  });

  it("keeps trailing-block locals visible after the call", () => {
    expect(
      check(`
def main(): number {
  const result = apply() { const local = 3; return local }
  return local + result
}
`),
    ).toEqual([]);
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

  it.each([
    ["plain", ""],
    ["with modifier", " with approve"],
  ])("reports each const reassignment and mutation once (%s)", (_, modifier) => {
    const errors = check(`
def main(): number {
  const result = apply() {
    const assigned = 1
    assigned = 2
    return assigned
  }${modifier}
  return apply() {
    const incremented = result
    incremented++
    return incremented
  }${modifier}
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
    expect(errors.map((error) => [error.code, error.message])).toEqual([
      ["AG2001", "Type 'number' is not assignable to type 'void' (block return)."],
    ]);
  });
});
