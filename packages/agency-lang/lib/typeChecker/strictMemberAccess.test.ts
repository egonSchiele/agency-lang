import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { AgencyConfig } from "../config.js";

const STRICT_UNION_PHRASE = "is not available on every member";

function run(source: string, config: Partial<AgencyConfig> = {}) {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, config, info);
}

function check(source: string, config: Partial<AgencyConfig> = {}) {
  const result = run(source, config);
  return {
    errors: result.errors
      .filter((e) => (e.severity ?? "error") === "error")
      .map((e) => e.message),
    warnings: result.errors
      .filter((e) => e.severity === "warning")
      .map((e) => e.message),
  };
}

const U = `type U = { kind: "a", v: string } | { kind: "b", w: number }`;

describe("strict member access — general union", () => {
  it("silent (default): un-narrowed branch-specific access is lenient, no diagnostic", () => {
    const { errors, warnings } = check(`
${U}
def f(u: U): void {
  let x = u.v
}`);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warn: branch-specific access emits the strict warning (not an error)", () => {
    const { errors, warnings } = check(
      `
${U}
def f(u: U): void {
  let x = u.v
}`,
      { typechecker: { strictMemberAccess: "warn" } },
    );
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes(STRICT_UNION_PHRASE))).toBe(true);
  });

  it("error: branch-specific access is the strict error, and no warning", () => {
    const { errors, warnings } = check(
      `
${U}
def f(u: U): void {
  let x = u.v
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors.some((e) => e.includes(STRICT_UNION_PHRASE))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("error: a property on ALL members is always fine (no diagnostic)", () => {
    const { errors, warnings } = check(
      `
${U}
def f(u: U): void {
  let k = u.kind
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("error: a NARROWED branch-specific access never errors (guarded)", () => {
    const { errors } = check(
      `
${U}
def f(u: U): void {
  if (u.kind == "a") {
    let x = u.v
  }
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors).toEqual([]);
  });

  it("error: a property on NO member is still the hard 'does not exist' error", () => {
    const { errors } = check(
      `
${U}
def f(u: U): void {
  let z = u.nope
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors.some((e) => e.includes("does not exist"))).toBe(true);
  });

  it("error: a non-object union member counts as missing the field (locks the semantics)", () => {
    // `{ a: string } | string`: `.a` is present on the object arm only. The
    // string arm has no `.a`, so strict mode diagnoses. (At silent this returns
    // `string` leniently — covered by the silent test family.)
    const { errors } = check(
      `
type U2 = { a: string } | string
def f(u: U2): void {
  let x = u.a
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors.some((e) => e.includes(STRICT_UNION_PHRASE))).toBe(true);
  });

  it("error: 3-member union, field on 2 of 3 → strict error (exercises the union-collapse path)", () => {
    const { errors } = check(
      `
type U3 = { kind: "a", v: string } | { kind: "b", v: number } | { kind: "c", x: boolean }
def f(u: U3): void {
  let x = u.v
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors.some((e) => e.includes(STRICT_UNION_PHRASE))).toBe(true);
  });

  it("error: the diagnostic loc points at the access, not the receiver", () => {
    const src = `
${U}
def f(u: U): void {
  let x = u.v
}`;
    const result = run(src, { typechecker: { strictMemberAccess: "error" } });
    const diag = result.errors.find((e) =>
      e.message.includes(STRICT_UNION_PHRASE),
    );
    // loc.line is 0-indexed (docs/dev/locations.md); the `let x = u.v` access
    // is the 4th physical line → line 3.
    expect(diag?.loc?.line).toBe(3);
  });
});
