import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

const codes = (src: string): string[] =>
  typecheckSource(src)
    .filter((e) => e.code === "AG4012")
    .map((e) => e.message);

describe("AG4012: redeclaring a parameter name", () => {
  it("rejects a const that reuses a parameter name inside a match arm (issue #717)", () => {
    const errors = codes(`
type Sa = { tag: "a"; s: string }
type Sb = { tag: "b"; n: number }
type Su = Sa | Sb

def pick(u: Su): string {
  return match(u) {
    { tag: "a", s } => {
      const u: Su = { tag: "b", n: 1 }
      return s
    }
    _ => "other"
  }
}
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Cannot redeclare parameter 'u' with 'const'");
  });

  it("rejects a let at the top of a node body too", () => {
    const errors = codes(`
node greet(name: string) {
  let name = "x"
  return name
}
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'name' with 'let'");
  });

  it("allows a plain assignment to the parameter", () => {
    expect(
      codes(`
def f(n: number): number {
  n = n + 1
  return n
}
`),
    ).toEqual([]);
  });

  it("allows a local with a different name, and a same name in another function", () => {
    expect(
      codes(`
def f(n: number): number {
  const m = n
  return m
}
def g(m: number): number {
  const n = m
  return n
}
`),
    ).toEqual([]);
  });

  it("allows a block-local that shadows a parameter, since a block has its own scope", () => {
    expect(
      codes(`
def f(x: number): number[] {
  return fork([1, 2]) as item {
    const x = item + 1
    return x
  }
}
`),
    ).toEqual([]);
  });
});
