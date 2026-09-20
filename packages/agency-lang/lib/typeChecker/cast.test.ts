import { describe, expect, it } from "vitest";
import { allCodes, errorsWithCode } from "./castTestUtils.js";

const PRELUDE = `type Person = { name: string }\ntype Named = { name: string, age: number }\n`;

const wrap = (body: string) => `${PRELUDE}node main() {\n${body}\n}\n`;
const codes = (body: string) => allCodes(wrap(body));
const errorWith = (body: string, code: string) => errorsWithCode(wrap(body), code)[0];

describe("the type of a cast", () => {
  it("an unchecked cast has the target type", () => {
    // Assigning a Person to a number would be an error, so no errors means p is a Person.
    expect(codes(`  const raw: any = 1\n  const p: Person = raw as Person`)).toEqual([]);
    expect(codes(`  const raw: any = 1\n  const n: number = raw as Person`)).not.toEqual([]);
  });

  it("a checked cast is a Result", () => {
    expect(codes(`  const raw: any = 1\n  const p: Result<Person> = raw as Person!`)).toEqual([]);
    expect(codes(`  const raw: any = 1\n  const p: Person = raw as Person!`)).not.toEqual([]);
  });

  it("does not narrow the source variable", () => {
    expect(
      codes(`  const raw: unknown = 1\n  const p = raw as Person\n  const q: Person = raw`),
    ).not.toEqual([]);
  });

  // The undefined-variable check is off by default, so the row turns it on.
  it("sees a variable that is used only inside a cast", () => {
    const reportUndefined = { typechecker: { undefinedVariables: "error" } } as const;
    expect(allCodes(wrap(`  const p = missing as Person`), reportUndefined)).toContain("AG4007");
  });
});

describe("a cast does not hide a name from --agency-only", () => {
  // A cast is exactly the kind of wrapper that could hide a JavaScript
  // global from the bind check. The bare call is asserted beside it, so the
  // row fails if the check stops refusing either.
  const AGENCY_ONLY = { typechecker: { jsGlobals: "sandbox" } } as const;
  const refusals = (body: string) =>
    allCodes(wrap(body), AGENCY_ONLY).filter((code) => code === "AG4007");

  it("refuses `process` inside a cast, and bare", () => {
    expect(refusals(`  use(process as any)`)).toHaveLength(1);
    expect(refusals(`  use(process)`)).toHaveLength(1);
  });
});

describe("AG1014: unrelated casts", () => {
  it("refuses number to string and names the escape", () => {
    const err = errorWith(`  const n = 5\n  const s = n as string`, "AG1014");
    expect(err?.message).toContain("neither type fits the other");
    expect(err?.message).toContain("as unknown as string");
  });

  it("allows widening and narrowing", () => {
    expect(codes(`  const n: Named = { name: "a", age: 1 }\n  const p = n as Person`)).toEqual([]);
    expect(codes(`  const p: Person = { name: "a" }\n  const n = p as Named`)).toEqual([]);
  });

  it("allows the unknown escape and any in both directions", () => {
    expect(codes(`  const n = 5\n  const s = n as unknown as string`)).toEqual([]);
    expect(codes(`  const a: any = 5\n  const s = a as string`)).toEqual([]);
    expect(codes(`  const n = 5\n  const a = n as any`)).toEqual([]);
  });

  it("AG1018: tells the author to unwrap a Result, and does not suggest the escape", () => {
    const body = `  const r: Result<Person> = success({ name: "a" })\n  const p = r as Person`;
    const err = errorWith(body, "AG1018");
    expect(err?.message).toContain("does not unwrap");
    expect(err?.message).not.toContain("as unknown as");
    expect(codes(body)).not.toContain("AG1014");
  });

  it("does not apply to a checked cast", () => {
    expect(codes(`  const n = 5\n  const s = n as string!`)).toEqual([]);
  });
});

describe("AG1015: checked casts need a schema", () => {
  it("refuses a checked cast to a function type", () => {
    const err = errorWith(
      `  const f: any = 1\n  const g = f as ((n: number) => string)!`,
      "AG1015",
    );
    expect(err).toBeDefined();
  });

  it("allows an unchecked cast to a function type", () => {
    expect(codes(`  const f: any = 1\n  const g = f as (n: number) => string`)).toEqual([]);
  });
});
