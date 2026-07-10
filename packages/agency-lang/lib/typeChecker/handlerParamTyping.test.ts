import { describe, it, expect } from "vitest";
import { refineInlineHandlerParams } from "./handlerParamTyping.js";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function allErrors(source: string): TypeCheckError[] {
  const file = path.join(os.tmpdir(), `tc-h1-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`);
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, source);
    return typeCheck(parseResult.result, {}, info).errors;
  } finally {
    unlinkSync(file);
  }
}

const warningsFrom = (source: string) => allErrors(source).filter((e) => e.severity === "warning");
const errorsFrom = (source: string) => allErrors(source);
// A non-exhaustive `match` is a hard error by default now
// (typechecker.matchExhaustiveness default = "error"). These tests assert the
// missing case is DETECTED, independent of severity, so they match the message.
const exhaustivenessDiagsFrom = (source: string) =>
  allErrors(source).filter((e) => /not exhaustive/i.test(e.message));

describe("handler param .effect typing (H1)", () => {
  it("types e.effect so a non-exhaustive match(e.effect) is flagged", () => {
    const diags = exhaustivenessDiagsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def risky() {
  raise mytest::alpha("a", {})
  raise mytest::beta("b", {})
}
node main() {
  handle {
    risky()
  } with (e) {
    match (e.effect) {
      "mytest::alpha" => 1
    }
  }
}`);
    expect(diags.some((d) => /beta/.test(d.message))).toBe(true);
  });

  it("an explicit param annotation is not overridden", () => {
    const warnings = warningsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def risky() { raise mytest::alpha("a", {})\n raise mytest::beta("b", {}) }
node main() {
  handle { risky() } with (e: any) {
    match (e.effect) { "mytest::alpha" => 1 }
  }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message))).toBe(false);
  });

  it("a covered match(e.effect) is clean", () => {
    const warnings = warningsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def risky() { raise mytest::alpha("a", {})\n raise mytest::beta("b", {}) }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "mytest::alpha" => 1  "mytest::beta" => 2 }
  }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message))).toBe(false);
  });

  it("reading the 4 runtime fields (effect/message/data/origin) still type-checks", () => {
    const errs = errorsFrom(`
effect mytest::alpha { }
def risky() { raise mytest::alpha("a", {}) }
node main() {
  handle { risky() } with (e) {
    print(e.message)
    print(e.origin)
    let d = e.data
    return 0
  }
}`);
    expect(errs.some((e) => /does not exist|not assignable/i.test(e.message))).toBe(false);
  });

  it("H3: reading an unknown field on `e` is now a 'does not exist' error", () => {
    // This pass now runs BEFORE checkScopes, so `e` is the closed interrupt
    // object `{ effect, message, data, origin }` during field-access checking.
    // A field outside those four is a real error — the interrupt object has
    // exactly those members. (Under H1 this read was permissively allowed
    // because the retype happened after checkScopes.)
    const errs = errorsFrom(`
effect mytest::alpha { }
def risky() { raise mytest::alpha("a", {}) }
node main() {
  handle { risky() } with (e) {
    return e.notARealField
  }
}`);
    expect(errs.some((e) => /does not exist/i.test(e.message))).toBe(true);
  });

  it("functionRef handler is untouched (no crash, no spurious diagnostic)", () => {
    const errs = errorsFrom(`
effect mytest::alpha { }
def risky() { raise mytest::alpha("a", {}) }
def onErr(e: any): number { return 0 }
node main() {
  handle { risky() } with onErr
}`);
    expect(errs.some((e) => /not exhaustive/i.test(e.message))).toBe(false);
  });

  it("empty raisable set → param stays any → no diagnostic", () => {
    const warnings = warningsFrom(`
node main() {
  handle { let x = 1 } with (e) {
    match (e.effect) { "anything" => 1 }
  }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message))).toBe(false);
  });

  it("SOUNDNESS: two same-named inline handler params in one scope both stay any", () => {
    const warnings = warningsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def raiseA() { raise mytest::alpha("a", {}) }
def raiseB() { raise mytest::beta("b", {}) }
node main() {
  handle { raiseA() } with (e) { match (e.effect) { "mytest::alpha" => 1 } }
  handle { raiseB() } with (e) { match (e.effect) { "mytest::beta" => 2 } }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message))).toBe(false);
  });

  it("SOUNDNESS: a param name shared with an ANNOTATED handler is not clobbered", () => {
    // The first handler is annotated `e: any`; the second is eligible with the
    // SAME name. Typing the second would clobber the first's binding → the first
    // match(e.effect) would see the second's effect union and be wrongly flagged.
    // The name-count includes the annotated handler, so the eligible one is
    // skipped → neither is flagged.
    const warnings = warningsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def raiseA() { raise mytest::alpha("a", {}) }
def raiseB() { raise mytest::beta("b", {}) }
node main() {
  handle { raiseA() } with (e: any) { match (e.effect) { "mytest::alpha" => 1 } }
  handle { raiseB() } with (e) { match (e.effect) { "mytest::beta" => 2 } }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message))).toBe(false);
  });

  it("transitive raise (effect raised inside a called function) reaches the match", () => {
    const diags = exhaustivenessDiagsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def inner() { raise mytest::beta("b", {}) }
def risky() { raise mytest::alpha("a", {})\n inner() }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "mytest::alpha" => 1 }
  }
}`);
    expect(diags.some((d) => /beta/.test(d.message))).toBe(true);
  });

  it("effect name with :: is handled verbatim as the literal", () => {
    const diags = exhaustivenessDiagsFrom(`
effect ns::sub::alpha { }
effect ns::sub::beta { }
def risky() { raise ns::sub::alpha("a", {})\n raise ns::sub::beta("b", {}) }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "ns::sub::alpha" => 1 }
  }
}`);
    expect(diags.some((d) => /beta/.test(d.message))).toBe(true);
  });

  it("SOUNDNESS: an outer handle with a NESTED handle is not typed (no false positive)", () => {
    const warnings = warningsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def raiseA() { raise mytest::alpha("a", {}) }
def raiseB() { raise mytest::beta("b", {}) }
node main() {
  handle {
    handle { raiseA() } with (inner) { return 0 }
    raiseB()
  } with (e) {
    match (e.effect) { "mytest::beta" => 1 }
  }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message))).toBe(false);
  });
});

describe("handler effect exhaustiveness (H2)", () => {
  it("no double-report: the handle catches everything; only the inner match is flagged", () => {
    const diags = allErrors(`
effect mytest::alpha { }
effect mytest::beta { }
def risky() { raise mytest::alpha("a", {})\n raise mytest::beta("b", {}) }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "mytest::alpha" => 1 }
  }
}`);
    // Exactly one diagnostic — the exhaustiveness one. The handle block is a
    // catch-all, so the unhandled-interrupt check is satisfied (no extra diagnostic).
    expect(diags).toHaveLength(1);
    expect(/not exhaustive/i.test(diags[0].message)).toBe(true);
  });

  it("a `_` arm in match(e.effect) clears the diagnostic", () => {
    const warnings = warningsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def risky() { raise mytest::alpha("a", {})\n raise mytest::beta("b", {}) }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "mytest::alpha" => 1  _ => 0 }
  }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message))).toBe(false);
  });
});

// A "hard error" is any diagnostic with severity "error" (or no explicit
// severity, which renders as an error — e.g. type-mismatch diagnostics).
const hardErrorsFrom = (source: string) =>
  allErrors(source).filter((e) => (e.severity ?? "error") === "error");

describe("handler param payload typing (H3)", () => {
  it("types e as a discriminated union so match(e) checks B2 exhaustiveness", () => {
    const diags = exhaustivenessDiagsFrom(`
effect payl::a { x: number }
effect payl::b { y: string }
def risky() { raise payl::a("a", { x: 1 })\n raise payl::b("b", { y: "s" }) }
node main() {
  handle { risky() } with (e) {
    match (e) {
      { effect: "payl::a" } => 1
    }
  }
}`);
    // match(e) over the 2-member discriminated union is non-exhaustive: missing payl::b.
    expect(diags.some((d) => /payl::b/.test(d.message))).toBe(true);
  });

  it("errors on a payload-shape mismatch after narrowing on e.effect", () => {
    const errs = hardErrorsFrom(`
effect h3::deposit { amount: number }
def takesString(s: string): string { return s }
def risky() { raise h3::deposit("d", { amount: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3::deposit") { takesString(e.data.amount) }
  }
}`);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("accepts a correctly-typed payload use after narrowing", () => {
    const errs = hardErrorsFrom(`
effect h3::deposit { amount: number }
def takesNum(n: number): number { return n }
def risky() { raise h3::deposit("d", { amount: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3::deposit") { takesNum(e.data.amount) }
  }
}`);
    expect(errs).toEqual([]);
  });

  it("still refines e.effect for exhaustiveness (H1 regression)", () => {
    const diags = exhaustivenessDiagsFrom(`
effect h3::a { }
effect h3::b { }
def risky() { raise h3::a("a", {})\n raise h3::b("b", {}) }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "h3::a" => 1 }
  }
}`);
    expect(diags.some((d) => /h3::b/.test(d.message))).toBe(true);
  });
});

describe("handler param payload typing (H3) — edge cases", () => {
  it("member-path narrowing gives each branch its own payload", () => {
    const errs = hardErrorsFrom(`
effect h3i::a { n: number }
effect h3i::b { s: string }
def takesNum(n: number): number { return n }
def takesStr(s: string): string { return s }
def risky() { raise h3i::a("a", { n: 1 })\n raise h3i::b("b", { s: "x" }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3i::a") { takesNum(e.data.n) }
    if (e.effect == "h3i::b") { takesStr(e.data.s) }
  }
}`);
    expect(errs).toEqual([]);
  });

  it("does not leak the narrowed payload into the else branch", () => {
    // After `if (e.effect == "h3e::a")`, reading a's field in the else must error
    // (whether e narrows to the remaining member or stays the union, a's field is
    // absent from at least one member).
    const errs = hardErrorsFrom(`
effect h3e::a { n: number }
effect h3e::b { s: string }
def takesNum(n: number): number { return n }
def risky() { raise h3e::a("a", { n: 1 })\n raise h3e::b("b", { s: "x" }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3e::a") { takesNum(e.data.n) } else { takesNum(e.data.n) }
  }
}`);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("errors accessing a field on an empty-payload effect's data", () => {
    const errs = hardErrorsFrom(`
effect h3p::ping { }
def risky() { raise h3p::ping("p", {}) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3p::ping") { let x = e.data.nope }
  }
}`);
    expect(errs.some((x) => /does not exist/i.test(x.message))).toBe(true);
  });

  it("falls back to any for an effect dropped as conflicting", () => {
    // Conflicting declarations drop the effect from the registry → data: any →
    // field access is permitted (no derivative "does not exist").
    const errs = errorsFrom(`
effect h3c::e { a: number }
effect h3c::e { a: string }
def risky() { raise h3c::e("c", { a: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "h3c::e") { let x = e.data.anything }
  }
}`);
    expect(errs.some((x) => /does not exist/i.test(x.message))).toBe(false);
  });

  it("an effect named like a prototype key that is NOT an own registry entry is safe", () => {
    // Effect names are user-controlled (bare identifiers allowed). Here `toString`
    // is dropped from the registry (conflicting declarations), so it has no OWN
    // entry. Without an own-property guard, `registry["toString"]` would resolve
    // to Object.prototype.toString (a function) — crashing the raise-site check
    // and mistyping `e.data` as that function. The guard makes `data` fall back
    // to `any`, so field access is permitted and nothing crashes. We assert only
    // the conflict diagnostic — no crash, no spurious "does not exist".
    const errs = errorsFrom(`
effect toString { a: number }
effect toString { a: string }
def risky() { raise toString("t", { a: 1 }) }
node main() {
  handle { risky() } with (e) {
    if (e.effect == "toString") { let x = e.data.anything }
  }
}`);
    expect(errs.some((x) => /Conflicting payload types for effect 'toString'/.test(x.message))).toBe(true);
    expect(errs.some((x) => /does not exist/i.test(x.message))).toBe(false);
  });

  it("LIMITATION: a match(e) object-pattern arm does not narrow e.data inside the arm", () => {
    // Object-pattern match arms match+dispatch but do NOT narrow the scrutinee's
    // member access within the arm body, so `e.data.n` sees the full payload
    // union and errors. The supported idiom for per-effect payload access is the
    // member-path guard `if (e.effect == "...")` (see the tests above). Pinned so
    // a future reader sees this is a known boundary, not a regression.
    const errs = hardErrorsFrom(`
effect h3m::a { n: number }
effect h3m::b { s: string }
def takesNum(x: number): number { return x }
def takesStr(x: string): string { return x }
def risky() { raise h3m::a("a", { n: 1 })\n raise h3m::b("b", { s: "x" }) }
node main() {
  handle { risky() } with (e) {
    match (e) {
      { effect: "h3m::a" } => takesNum(e.data.n)
      { effect: "h3m::b" } => takesStr(e.data.s)
    }
  }
}`);
    expect(errs.some((x) => /not available on every member/i.test(x.message))).toBe(true);
  });
});

describe("ordering assertion", () => {
  it("throws if called after buildFlowGraphs (flowEnv already set)", () => {
    const ctx = { flowEnv: {} } as unknown as Parameters<
      typeof refineInlineHandlerParams
    >[2];
    expect(() => refineInlineHandlerParams([], {}, ctx, {})).toThrow(
      /must run before buildFlowGraphs/,
    );
  });
});
