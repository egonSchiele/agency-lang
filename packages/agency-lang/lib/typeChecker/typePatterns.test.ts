import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function check(source: string): TypeCheckError[] {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors;
}

// NEVER use an `any`-typed scrutinee in a test that proves narrowing — `any`
// permits every operation, so such a test passes whether or not narrowing
// works. Union scrutinees + an operation illegal on the un-narrowed union
// make these tests fail when narrowing breaks.
describe("type pattern narrowing", () => {
  it("is number narrows a union so the branch typechecks (fails without narrowing)", () => {
    // `+` is legal on strings too, so the discriminating operation must be a
    // call that REQUIRES number — that errors on the un-narrowed union.
    const errors = check(`
def wantsNumber(n: number): number {
  return n
}
def f(x: string | number): number {
  if (x is number) {
    return wantsNumber(x)
  }
  return 0
}
`);
    expect(errors).toEqual([]);
  });

  it("arm binder receives the narrowed type (fails without narrowing)", () => {
    const errors = check(`
def wantsNumber(n: number): number {
  return n
}
def f(x: string | number): number {
  return match (x) {
    n: number => wantsNumber(n)
    _ => 0
  }
}
`);
    expect(errors).toEqual([]);
  });

  it("tier 2 narrowing: field access valid only after the Person test", () => {
    const errors = check(`
type Person = { name: string }
def f(x: string | Person): string {
  return match (x) {
    {name}: Person => name
    _ => "none"
  }
}
`);
    expect(errors).toEqual([]);
  });

  it("narrowing is positive-only: after-branch stays un-narrowed", () => {
    // v1 has NO negative narrowing for TYPE patterns, so after the early
    // return x is STILL string | number and `x + 1` must error. If negative
    // narrowing lands later, this test flips on purpose. NOTE: written with
    // `is string`, not `is null` — the null literal path lowers to `== null`
    // which already narrows both branches through the presence machinery.
    const errors = check(`
def wantsNumber(n: number): number {
  return n
}
def f(x: string | number): number {
  if (x is string) {
    return 0
  }
  return wantsNumber(x)
}
`);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("the expression synthesizes boolean, not any", () => {
    const errors = check(`
def f(x: any): string {
  const b: string = x is string
  return b
}
`);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("is object narrows to the opaque object primitive: member access errors", () => {
    // Decision (plan review finding 8): `object` stays opaque. `is object`
    // means "I can stringify or pass this along", not "I can read fields".
    const errors = check(`
def f(draft: string | object): string {
  if (draft is object) {
    return draft.title
  }
  return ""
}
`);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("type pattern diagnostics", () => {
  it("unknown type name in is-position is AG1013, and ONLY AG1013", () => {
    const errors = check(`
def f(x: any): boolean {
  return x is Bogus
}
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("AG1013");
  });

  it("JS-native class names get the tailored AG1013 message", () => {
    const errors = check(`
def f(x: any): boolean {
  return x is Date
}
`);
    const err = errors.find((e) => e.code === "AG1013");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/JavaScript class/);
  });
});

describe("type patterns and exhaustiveness", () => {
  it("type-pattern arms do not satisfy exhaustiveness", () => {
    const errors = check(`
def f(x: "a" | "b"): number {
  return match (x) {
    s: string => 1
  }
}
`);
    expect(errors.some((e) => e.code === "AG5002")).toBe(true);
  });

  it("coarse type arms over a fully covered union still demand _", () => {
    // Spec v1 decision: type-pattern arms NEVER earn exhaustiveness credit,
    // even when coarse Tier 1 arms provably cover the closed union.
    const errors = check(`
def f(x: "a" | "b"): number {
  return match (x) {
    is string => 1
    is number => 2
  }
}
`);
    expect(errors.some((e) => e.code === "AG5002")).toBe(true);
  });
});

describe("binder-shadows-type warnings", () => {
  it("bare binder arm named like a type warns AG5003", () => {
    const errors = check(`
type Person = { name: string }
def f(x: any): string {
  return match (x) {
    Person => "bound"
    _ => "no"
  }
}
`);
    expect(
      errors.some((e) => e.code === "AG5003" && e.severity === "warning"),
    ).toBe(true);
  });

  it("property-position binder named like a type warns AG5004", () => {
    // In pattern position, {name: string} binds the name field to a variable
    // called "string" — it does NOT test the field type. Warn.
    const errors = check(`
def f(x: any): string {
  return match (x) {
    {name: string} => string
    _ => "no"
  }
}
`);
    expect(errors.some((e) => e.code === "AG5004")).toBe(true);
  });

  it("negatives: ordinary binders and guarded arms do not warn", () => {
    const errors = check(`
type Person = { name: string }
def f(x: any): string {
  return match (x) {
    other if (other != null) => "guarded"
    rest => "bound"
  }
}
`);
    expect(errors.some((e) => e.code === "AG5003" || e.code === "AG5004")).toBe(false);
  });
});

describe("review fixes (PR #631)", () => {
  it("coarse test on a literal union does not widen it", () => {
    // `is string` on "a" | "b" must KEEP the literal union: replacing it
    // with `string` would make returning x where "a" | "b" is expected fail.
    const errors = check(`
def f(x: "a" | "b"): "a" | "b" {
  if (x is string) {
    return x
  }
  return "a"
}
`);
    expect(errors).toEqual([]);
  });

  it("typed arms warn AG5004 for property binders named like types", () => {
    const errors = check(`
type Person = { name: string }
def f(x: any): string {
  return match (x) {
    {name: string}: Person => "typed"
    _ => "no"
  }
}
`);
    expect(errors.some((e) => e.code === "AG5004")).toBe(true);
  });

  it("nested object patterns warn AG5004", () => {
    const errors = check(`
def f(x: any): string {
  return match (x) {
    {a: {name: string}} => "nested"
    _ => "no"
  }
}
`);
    expect(errors.some((e) => e.code === "AG5004")).toBe(true);
  });

  it("shadow warnings anchor to the arm, not the match head", () => {
    // The offending arm is the LAST of three; its loc must sit below the
    // first arm's line, proving we point at the binder rather than match(.
    const errors = check(`
type Person = { name: string }
def f(x: any): string {
  return match (x) {
    "first" => "a"
    "second" => "b"
    Person => "bound"
    _ => "no"
  }
}
`);
    const warning = errors.find((e) => e.code === "AG5003");
    expect(warning).toBeDefined();
    const firstArmLine = errors.length >= 0 ? 5 : 0;
    expect(warning!.loc?.line).toBeGreaterThan(firstArmLine);
  });
});
