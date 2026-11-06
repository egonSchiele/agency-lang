import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

const codes = (source: string): string[] => typecheckSource(source).map((error) => error.code);
const reported = (source: string): string[] =>
  typecheckSource(source)
    .filter((error) => error.code === "AG1035")
    .map((error) => error.message.split("'")[1]);

describe("an alias that lists itself in its own union (AG1035)", () => {
  it("reports the alias and nothing else, however it is used", () => {
    const uses = [
      "const y: A = x",
      "const y = g(x)",
      "const y = f()",
      "const y: A[] = [x]",
      "const y: Result<A> = try f()",
    ];
    for (const use of uses) {
      const source = `type A = number | A
def f(): A { return 1 }
def g(a: A): number { return 1 }
node main() {
  const x: A = 1
  ${use}
}`;
      expect(codes(source), use).toEqual(["AG1035"]);
    }
  });

  it("reports each alias of a pair that name each other", () => {
    const source = `type A = B | number
type B = A | string
node main() {
  const x: A = 1
  const y: A = x
}`;
    expect(reported(source).sort()).toEqual(["A", "B"]);
  });

  it("reports an alias that reaches itself through a plain alias of itself", () => {
    const source = `type A = B
type B = A
node main() {
  const x: A = 1
}`;
    expect(reported(source).sort()).toEqual(["A", "B"]);
  });

  it("reports a generic alias that lists itself", () => {
    const source = `type Box<T> = T | Box<T>
node main() {
  const x: Box<number> = 1
}`;
    expect(reported(source)).toEqual(["Box"]);
  });

  it("points at the alias declaration", () => {
    const [error] = typecheckSource(`node main() {
  return 1
}
type A = number | A`).filter((found) => found.code === "AG1035");
    expect(error.loc?.line).toBe(3);
  });

  it("allows an alias that refers to itself inside a structure", () => {
    const source = `type Tree = { kids: Tree[] }
type Json = string | number | Json[] | Record<string, Json>
type Chain = { next: Chain | null }
node main() {
  const tree: Tree = { kids: [] }
  const other: Tree = tree
  const json: Json = ["a", 1]
  const chain: Chain = { next: null }
}`;
    expect(codes(source)).toEqual([]);
  });

  it("is not confused by a type named like a key of the object prototype", () => {
    const source = `type Odd = number | toString | constructor<number>
node main() {
  const x: number = 1
}`;
    expect(reported(source)).toEqual([]);
  });

  it("allows a union of other aliases", () => {
    const source = `type A = number
type B = string
type C = A | B
node main() {
  const x: C = 1
  const y: C = x
}`;
    expect(codes(source)).toEqual([]);
  });
});
