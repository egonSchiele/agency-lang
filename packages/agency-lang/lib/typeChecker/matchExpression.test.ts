import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { AgencyConfig } from "../config.js";

function check(source: string, config: Partial<AgencyConfig> = {}): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, config, info).errors.map((e) => e.message);
}

// Typed Result so the success payload is `number` (bare `Result` would widen it
// to `any`, collapsing the narrowed-binding union). Mirrors the TRY helper in
// matchExhaustiveness.test.ts.
const TRY = `def tryParse(input: string): Result<number, string> {
  if (input == "ok") {
    return success(42)
  }
  return failure("bad input")
}`;

describe("match expressions — union typing + exhaustiveness", () => {
  it("annotation mismatch is exactly one assignability error", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val: boolean = match(r) {
    success(v) => "yes"
    failure(e) => "no"
  }
  return val
}`);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/val/);
    expect(errs[0]).toMatch(/boolean/);
  });

  it("compatible annotation: no errors", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val: string = match(r) {
    success(v) => "yes"
    failure(e) => "no"
  }
  return val
}`);
    expect(errs).toEqual([]);
  });

  it("synthesis: union flows to downstream use", () => {
    // val: number | string; using it where boolean is required must error and
    // the message must mention the union members.
    const errs = check(`node main(x: string) {
  const val = match(x) {
    "a" => 1
    _ => "s"
  }
  const flag: boolean = val
  return flag
}`);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/number/);
    expect(errs[0]).toMatch(/string/);
  });

  it("narrowed bindings type the yields (Result value flows through)", () => {
    // v is narrowed to the success payload; v is returned directly. Annotating
    // val as string must error mentioning number (payload of success(42)).
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val: string = match(r) {
    success(v) => v
    failure(e) => "fallback"
  }
  return val
}`);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/number/);
  });

  it("nested expression match: inner union feeds the outer yield", () => {
    const errs = check(`node main(x: string) {
  const val: boolean = match(x) {
    "a" => {
      return match(x) {
        "b" => 1
        _ => 2
      }
    }
    _ => 3
  }
  return val
}`);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/number/);
  });

  it("discriminant narrowing applies to field-access yields (valid code accepted)", () => {
    // Matching on `e.kind` narrows `e` inside each literal arm, so `e.val` is
    // `number` in the "a" arm — the union is `number`, and the annotated
    // downstream use must NOT error.
    const errs = check(`node main(e: { kind: "a", val: number } | { kind: "b", val: string }) {
  const out = match(e.kind) {
    "a" => e.val
    "b" => 0
  }
  const n: number = out
  return n
}`);
    expect(errs).toEqual([]);
  });

  it("an any-typed yield collapses the union to any (no errors)", () => {
    const errs = check(`node main(x: any) {
  const val: boolean = match("k") {
    "k" => x
    _ => 1
  }
  return val
}`);
    expect(errs).toEqual([]);
  });

  it("literal-union annotation accepts literal yields (per-arm unwidened check)", () => {
    // Regression: the widened union `string` was falsely rejected against a
    // `"a" | "b"` annotation. Each arm's UNWIDENED literal must be checked.
    const errs = check(`type Category = "a" | "b"
node main(x: string) {
  const c: Category = match(x) {
    "go" => "a"
    _ => "b"
  }
  return c
}`);
    expect(errs).toEqual([]);
  });

  it("a genuinely wrong yield errors, naming the offending arm's value", () => {
    const errs = check(`type Category = "a" | "b"
node main(x: string) {
  const c: Category = match(x) {
    "go" => "a"
    _ => "c"
  }
  return c
}`);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/"c"/);
    expect(errs[0]).toMatch(/Category/);
  });

  it("return match(...) against a literal-union return type passes", () => {
    const errs = check(`type Category = "a" | "b"
def pick(x: string): Category {
  return match(x) {
    "go" => "a"
    _ => "b"
  }
}`);
    expect(errs).toEqual([]);
  });

  it("return match(...) with a wrong yield errors against the return type", () => {
    const errs = check(`type Category = "a" | "b"
def pick(x: string): Category {
  return match(x) {
    "go" => "a"
    _ => "c"
  }
}`);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/"c"/);
  });

  it("expression exhaustiveness is a hard error even under silent config", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val = match(r) {
    success(v) => 1
  }
  return val
}`, { typechecker: { matchExhaustiveness: "silent" } });
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(true);
  });

  it("guarded arm does not count toward expression exhaustiveness", () => {
    // NOTE: the brief's `success(v) if (v > 0)` shape hits a pre-existing parser
    // bug (guards on result/bare-binding patterns fail to parse inside node/def
    // bodies). Substituted with an object-pattern guard over a discriminated
    // union — same property (a guarded arm doesn't count toward coverage), a
    // parseable shape.
    const errs = check(`node main(x: { kind: "a", v: number } | { kind: "b" }) {
  const val = match(x) {
    { kind: "a", v } if (v > 0) => 1
    { kind: "b" } => 0
  }
  return val
}`);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(true);
  });

  it("statement match exhaustiveness still honors silent config", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match(r) {
    success(v) => tryParse("x")
  }
  return 0
}`, { typechecker: { matchExhaustiveness: "silent" } });
    expect(errs).toEqual([]);
  });
});
