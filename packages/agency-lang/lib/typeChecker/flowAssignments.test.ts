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

  it("post-guard narrowing flows into assignment checks (via flow, not child scope)", () => {
    // The architectural goal of PR 3: the flow graph (PR 2) carries the
    // post-guard narrowing into the Phase B assignment check — the path that
    // previously required the postGuardFacts / walkWithNarrowing dance in
    // walkScopeBody. Behavior-preserving (passed before too); this locks that
    // it still holds once the child-scope dance is gone.
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
});
