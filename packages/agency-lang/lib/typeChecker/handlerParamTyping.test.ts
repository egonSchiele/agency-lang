import { describe, it, expect } from "vitest";
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

describe("handler param .effect typing (H1)", () => {
  it("types e.effect so a non-exhaustive match(e.effect) warns", () => {
    const warnings = warningsFrom(`
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
    expect(warnings.some((w) => /not exhaustive/i.test(w.message) && /beta/.test(w.message))).toBe(true);
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

  it("NOT a breaking change: reading an unknown field is still allowed", () => {
    // Field-access checking runs in checkScopes, BEFORE this pass re-types `e`.
    // The refined `.effect` type only ever reaches checkMatchExhaustiveness, so
    // no field read (known or unknown) is re-checked against the object type —
    // `e.notARealField` stays allowed exactly as it was when `e` was `any`.
    const errs = errorsFrom(`
effect mytest::alpha { }
def risky() { raise mytest::alpha("a", {}) }
node main() {
  handle { risky() } with (e) {
    return e.notARealField
  }
}`);
    expect(errs.some((e) => /does not exist/i.test(e.message))).toBe(false);
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

  it("transitive raise (effect raised inside a called function) reaches the match", () => {
    const warnings = warningsFrom(`
effect mytest::alpha { }
effect mytest::beta { }
def inner() { raise mytest::beta("b", {}) }
def risky() { raise mytest::alpha("a", {})\n inner() }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "mytest::alpha" => 1 }
  }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message) && /beta/.test(w.message))).toBe(true);
  });

  it("effect name with :: is handled verbatim as the literal", () => {
    const warnings = warningsFrom(`
effect ns::sub::alpha { }
effect ns::sub::beta { }
def risky() { raise ns::sub::alpha("a", {})\n raise ns::sub::beta("b", {}) }
node main() {
  handle { risky() } with (e) {
    match (e.effect) { "ns::sub::alpha" => 1 }
  }
}`);
    expect(warnings.some((w) => /not exhaustive/i.test(w.message) && /beta/.test(w.message))).toBe(true);
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
