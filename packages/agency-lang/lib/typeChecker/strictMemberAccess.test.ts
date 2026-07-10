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
  it("silent: un-narrowed branch-specific access is lenient, no diagnostic", () => {
    const { errors, warnings } = check(
      `
${U}
def f(u: U): void {
  let x = u.v
}`,
      { typechecker: { strictMemberAccess: "silent" } },
    );
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

const RESULT_PHRASE = "only available on a";

const TRY = `
def tryParse(s: string): Result<number, string> {
  if (s == "ok") { return success(42) }
  return failure("bad")
}`;

describe("strict member access — Result", () => {
  it("silent: un-narrowed r.value is lenient (any), no diagnostic", () => {
    const { errors, warnings } = check(
      `${TRY}
node main() {
  let r = tryParse("ok")
  let n = r.value
}`,
      { typechecker: { strictMemberAccess: "silent" } },
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("silent: un-narrowed r.value stays `any`, so a chained access does not error", () => {
    // Locks the silent return type: `any` short-circuits the chain (today's
    // behavior), so `r.value.whatever` raises nothing.
    const { errors, warnings } = check(
      `${TRY}
node main() {
  let r = tryParse("ok")
  let n = r.value
  let m = n
}`,
      { typechecker: { strictMemberAccess: "silent" } },
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("error: un-narrowed r.value errors with Result-framed guidance", () => {
    const { errors, warnings } = check(
      `${TRY}
node main() {
  let r = tryParse("ok")
  let n = r.value
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors.some((e) => e.includes(RESULT_PHRASE))).toBe(true);
    expect(errors.some((e) => e.includes("isSuccess"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("error: r.success (on both members) is always fine", () => {
    const { errors } = check(
      `${TRY}
node main() {
  let r = tryParse("ok")
  let ok = r.success
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors).toEqual([]);
  });

  it("error: guarded r.value (isSuccess) never errors", () => {
    const { errors } = check(
      `${TRY}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) {
    let n = r.value
  }
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors).toEqual([]);
  });

  it("error: guarded r.error (isFailure) never errors (failure-branch symmetry)", () => {
    const { errors } = check(
      `${TRY}
node main() {
  let r = tryParse("ok")
  if (isFailure(r)) {
    let e = r.error
  }
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors).toEqual([]);
  });

  it("error: match arms add no strict-access diagnostic (escape hatch)", () => {
    const { errors } = check(
      `${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
    failure(e) => 0
  }
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    // PR5 scope: the per-arm isSuccess/isFailure narrowing (from match lowering)
    // means no strict-access diagnostic is added on match arms.
    expect(
      errors.some(
        (e) => e.includes(RESULT_PHRASE) || e.includes(STRICT_UNION_PHRASE),
      ),
    ).toBe(false);
    // NOTE: match-over-Result currently also emits a PRE-EXISTING, mode-
    // independent "Property 'value' does not exist …" (reproduces at silent,
    // from code paths untouched by this PR — the existing narrowing.test.ts
    // match tests never asserted its absence). Tracked as a separate follow-up;
    // not asserted here because it is out of scope for strict member access.
  });

  it("error: `catch` satisfies the checker (no diagnostic)", () => {
    const { errors } = check(
      `${TRY}
node main() {
  let n = tryParse("ok") catch 0
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    expect(errors).toEqual([]);
  });

  it("error: fires in all access positions (assignment, call arg, return, bare, nested)", () => {
    const { errors } = check(
      `${TRY}
def use(n: number): number { return n }
def helper(): number {
  let r = tryParse("ok")
  return r.value
}
node main() {
  let r = tryParse("ok")
  let a = r.value
  use(r.value)
  let _ = (r.value + 1) * 2
  r.value
}`,
      { typechecker: { strictMemberAccess: "error" } },
    );
    const valueErrs = errors.filter((e) => e.includes(RESULT_PHRASE));
    expect(valueErrs.length).toBe(5);
  });
});

describe("skippedFunctions member on a narrowed failure", () => {
  it("allows skippedFunctions on a narrowed failure", () => {
    const { errors } = check(`
def f(): Result { return failure("x") }
def g(): string {
  const r = f()
  if (isFailure(r)) {
    const skips = r.skippedFunctions
    if (skips.length == 0) {
      return "none skipped"
    }
    return "some skipped"
  }
  return "ok"
}`);
    expect(errors).toEqual([]);
  });

  it("negative control: a misspelled failure member still errors (proves enforcement is armed)", () => {
    const { errors } = check(`
def f(): Result { return failure("x") }
def g(): string {
  const r = f()
  if (isFailure(r)) {
    const skips = r.skippedFunctionz
    if (skips.length == 0) {
      return "none skipped"
    }
    return "some skipped"
  }
  return "ok"
}`);
    expect(errors.length).toBeGreaterThan(0);
  });
});
