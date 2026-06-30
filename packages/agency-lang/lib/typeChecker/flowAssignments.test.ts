import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

describe("assignment value-checks run flow-aware (PR 3)", () => {
  const R = `type R = { kind: "a", v: string } | { kind: "b", v: number }`;

  it("annotated assignment with a narrowed RHS passes", () => {
    expect(check(`
${R}
def f(r: R): void {
  if (r.kind == "a") {
    let s: string = r.v
  }
}`)).toEqual([]);
  });

  it("annotated assignment with a wrong RHS still errors", () => {
    expect(check(`
def f(): void {
  let s: string = 5
}`)).toEqual([
      "Type 'number' is not assignable to type 'string' (assignment to 's').",
    ]);
  });

  it("reassignment is checked against the declared type", () => {
    expect(check(`
def f(): void {
  let n: number = 1
  n = "x"
}`)).toEqual([
      `Type '"x"' is not assignable to type 'number'.`,
    ]);
  });

  it("post-guard narrowing flows into the assignment check via the flow graph", () => {
    // The assignment value-check now runs in the flow-aware Phase B pass, so the
    // flow graph (PR 2) — not the child-scope walk — carries the post-guard
    // narrowing (early-return on the `err` arm leaves `r` narrowed to `ok`) into
    // the `let s: string = r.value` check. Behavior-preserving (passed before via
    // the child-scope path too); this locks that the flow path covers it.
    expect(check(`
type R2 = { kind: "ok", value: string } | { kind: "err", msg: string }
def f(r: R2): string {
  if (r.kind == "err") {
    return "bad"
  }
  let s: string = r.value
  return s
}`)).toEqual([]);
  });

  it("access-chain write checks the LHS target against the NARROWED base", () => {
    // `t.box.n = "wrong"` writes a member whose type depends on narrowing the
    // base `t`. Inside the `kind == "a"` guard, t.box.n is `number`, so the
    // string RHS must error. The LHS target is synthesized from a *synthetic*
    // base node, so this only passes if that base resolves through the flow
    // graph (typeAt) — a flat scope.lookup would see the wide union and the
    // string would be assignable to `number | string`, silently dropping it.
    expect(check(`
type T = { kind: "a", box: { n: number } } | { kind: "b", box: { n: string } }
def f(t: T): void {
  if (t.kind == "a") {
    t.box.n = "wrong"
  }
}`)).toContainEqual(
      expect.stringContaining("not assignable to type 'number'"),
    );
  });

  it("access-chain index write checks against the narrowed record value type", () => {
    // Symmetric to the property-write case but through a Record index write
    // (`t.m["k"] = …`): the value type is `number` once `t` is narrowed to the
    // "a" member, so the string RHS must error.
    expect(check(`
type T = { kind: "a", m: Record<string, number> } | { kind: "b", m: Record<string, string> }
def f(t: T): void {
  if (t.kind == "a") {
    t.m["k"] = "wrong"
  }
}`)).toContainEqual(
      expect.stringContaining("not assignable to type 'number'"),
    );
  });
});
