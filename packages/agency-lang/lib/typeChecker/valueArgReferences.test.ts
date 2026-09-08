import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

const codes = (src: string, code = "AG7007"): string[] =>
  typecheckSource(src)
    .filter((e) => e.code === code)
    .map((e) => e.message);

const GREATER_THAN = `
def greaterThan(minValue: number, value: number): Result<number> {
  if (value > minValue) {
    return success(value)
  }
  return failure("expected \${value} to be > \${minValue}")
}

@validate(greaterThan.partial(minValue: minValue))
type GreaterThan(minValue: number) = number
`;

describe("AG7007: a value argument that is not a static", () => {
  it("rejects a plain top-level const used in a node-body alias (issue #441)", () => {
    const errors = codes(`
const minAge: number = 5
${GREATER_THAN}
node main() {
  type Age = GreaterThan(minAge)
  const ages: Age[]! = [-1, 2, 3]
  return ages
}
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "Type 'GreaterThan' takes value argument 'minAge', which is a top-level variable",
    );
  });

  it("rejects a parameter and a local used as a value argument", () => {
    const errors = codes(`
${GREATER_THAN}
def check(low: number, v: number): boolean {
  const floor = low
  const a: GreaterThan(low)! = v
  const b: GreaterThan(floor)! = v
  return isSuccess(a) && isSuccess(b)
}
`);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("'low', which is a parameter");
    expect(errors[1]).toContain("'floor', which is a local variable");
  });

  it("allows a static const, a literal, and a forwarded value parameter", () => {
    expect(
      codes(`
static const minAge: number = 5
${GREATER_THAN}
type Age = GreaterThan(minAge)
type Zero = GreaterThan(0)
type Above(floor: number) = GreaterThan(floor)
node main() {
  type Local = GreaterThan(minAge)
  const a: Age! = 10
  return a
}
`),
    ).toEqual([]);
  });

  it("treats an aliased import by its local name, so a same-named parameter is still rejected", () => {
    const errors = codes(`
import { min as low } from "std::validation"
${GREATER_THAN}
def check(min: number, v: number): boolean {
  const a: GreaterThan(low)! = v
  const b: GreaterThan(min)! = v
  return isSuccess(a) && isSuccess(b)
}
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'min', which is a parameter");
  });

  it("checks schema(T) and `x is T` sites too", () => {
    const errors = codes(`
${GREATER_THAN}
def check(low: number, v: number): boolean {
  const s = schema(GreaterThan(low))
  return v is GreaterThan(low)
}
`);
    expect(errors).toHaveLength(2);
  });

  it("checks a value parameter default", () => {
    const errors = codes(`
const minAge: number = 5
def atLeast(minValue: number, value: number): Result<number> {
  return success(value)
}
@validate(atLeast.partial(minValue: floor))
type AtLeast(floor: number = minAge) = number
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "Type 'AtLeast' takes value argument 'minAge', which is a top-level variable",
    );
  });

  it("reports a name that resolves to nothing as an undefined variable when that pass is on", () => {
    const src = `
static const minAge: number = 5
${GREATER_THAN}
type Age = GreaterThan(mniAge)
`;
    expect(codes(src, "AG4007")).toEqual([]);
    const errors = typecheckSource(src, { typechecker: { undefinedVariables: "error" } })
      .filter((e) => e.code === "AG4007")
      .map((e) => e.message);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("mniAge");
  });
  it("lets a static const win over a same-named local elsewhere in the body", () => {
    expect(
      codes(`
static const minAge: number = 18
${GREATER_THAN}
def check(age: GreaterThan(minAge)): boolean {
  if (age > 10) {
    let minAge = 1
  }
  return true
}
`),
    ).toEqual([]);
  });

  it("rejects a block parameter and a loop variable", () => {
    const errors = codes(`
${GREATER_THAN}
def each(items: number[], cb: (number) => void): void {
  for (item in items) {
    cb(item)
  }
}
def check(xs: number[]): boolean {
  for (x in xs) {
    const a: GreaterThan(x)! = 1
  }
  each(xs) as y {
    const b: GreaterThan(y)! = 1
  }
  return true
}
`);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("'x', which is a local variable");
    expect(errors[1]).toContain("'y', which is a local variable");
  });

  it("lets a default name an earlier value parameter of the same alias", () => {
    const src = `
def between(low: number, high: number, value: number): Result<number> {
  return success(value)
}
@validate(between.partial(low: low, high: high))
type Between(low: number, high: number = low) = number
`;
    expect(codes(src)).toEqual([]);
    expect(
      typecheckSource(src, { typechecker: { undefinedVariables: "error" } }).filter(
        (e) => e.code === "AG4007",
      ),
    ).toEqual([]);
  });

  it("does not mistake a prototype property name for a known binding", () => {
    const src = `
${GREATER_THAN}
type Age = GreaterThan(toString)
`;
    const errors = typecheckSource(src, { typechecker: { undefinedVariables: "error" } })
      .filter((e) => e.code === "AG4007")
      .map((e) => e.message);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("toString");
  });
});
