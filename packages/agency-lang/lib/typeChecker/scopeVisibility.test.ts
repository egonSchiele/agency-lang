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

describe("with-modifier declarations are visible to the scope builder", () => {
  it("infers the type of a `const x = f() with approve` declaration", () => {
    const errs = check(`
def getNum(): number { return 5 }
def wantsString(s: string): string { return s }
def main() {
  const f = getNum() with approve
  wantsString(f)
}
`);
    expect(
      errs.some((e) =>
        e.includes(
          "Argument type 'number' is not assignable to parameter type 'string'",
        ),
      ),
    ).toBe(true);
  });

  it("does not flag a correctly-typed `with approve` declaration", () => {
    const errs = check(`
def getStr(): string { return "x" }
def wantsString(s: string): string { return s }
def main() {
  const f = getStr() with approve
  wantsString(f)
}
`);
    expect(errs).toEqual([]);
  });

  it("tracks const-ness through a with modifier", () => {
    const errs = check(`
def getNum(): number { return 5 }
def main() {
  const f = getNum() with approve
  f = 6
}
`);
    expect(
      errs.some((e) => e.includes("Cannot reassign to constant 'f'")),
    ).toBe(true);
  });
});

describe("module-level bindings are visible inside function and node scopes", () => {
  it("flags a top-level const used at the wrong type inside a def", () => {
    const errs = check(`
const f = 5
def main() {
  const x: string = f
}
`);
    expect(
      errs.some((e) =>
        e.includes("Type 'number' is not assignable to type 'string'"),
      ),
    ).toBe(true);
  });

  it("flags a top-level const passed as a wrongly-typed argument inside a node", () => {
    const errs = check(`
def wantsString(s: string): string { return s }
const f = 5
node main() {
  const r = wantsString(f)
}
`);
    expect(
      errs.some((e) =>
        e.includes(
          "Argument type 'number' is not assignable to parameter type 'string'",
        ),
      ),
    ).toBe(true);
  });

  it("flags the combined case: top-level `with approve` declaration misused in a node", () => {
    const errs = check(`
def getNum(): number { return 5 }
def wantsString(s: string): string { return s }
const f = getNum() with approve
node main() {
  const r = wantsString(f)
}
`);
    expect(
      errs.some((e) =>
        e.includes(
          "Argument type 'number' is not assignable to parameter type 'string'",
        ),
      ),
    ).toBe(true);
  });

  it("flags reassignment of a top-level const inside a def", () => {
    const errs = check(`
const f = 5
def main() {
  f = 6
}
`);
    expect(
      errs.some((e) => e.includes("Cannot reassign to constant 'f'")),
    ).toBe(true);
  });

  it("lets a parameter shadow a top-level binding", () => {
    const errs = check(`
const f = 5
def main(f: string) {
  const x: string = f
}
`);
    expect(errs).toEqual([]);
  });

  it("lets a local declaration shadow a top-level binding", () => {
    const errs = check(`
const f = 5
def main() {
  const f = "local"
  const x: string = f
}
`);
    expect(errs).toEqual([]);
  });

  it("does not leak locals from one function into another", () => {
    const errs = check(`
def a() {
  const g = "str"
}
def b() {
  const x: number = g
}
`);
    expect(errs).toEqual([]);
  });

  it("allows iterating a typed-`any` value in a for loop", () => {
    // Surfaced by the with-modifier fix: an `is success(v)` binder over a
    // bare `Result` binds `v` as typed `any`, which the for-loop iterable
    // check rejected even though the string "any" is accepted.
    const errs = check(`
def f(x: any) {
  for (e in x) {
    print(e)
  }
}
`);
    expect(errs.filter((e) => e.includes("For-loop iterable"))).toEqual([]);
  });

  it("does not leak locals from a function into the top level", () => {
    const errs = check(`
def a() {
  const g = "str"
}
const x: number = g
`);
    expect(errs).toEqual([]);
  });
});
