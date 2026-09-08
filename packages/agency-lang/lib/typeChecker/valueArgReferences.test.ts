import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

const codes = (src: string): string[] =>
  typecheckSource(src)
    .filter((e) => e.code === "AG7007")
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
});
