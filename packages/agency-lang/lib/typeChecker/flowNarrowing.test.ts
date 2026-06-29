import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import { walkNodes } from "../utils/node.js";
import type { AgencyProgram, AgencyNode } from "../types.js";

// Parse + full pipeline; returns errors AND the (post-check) result so tests
// can inspect ctx.flowEnv. The parsed program is returned too, so a test can
// grab the exact node objects the checker walked (identity guard).
function run(source: string): {
  errors: string[];
  result: ReturnType<typeof typeCheck>;
  program: AgencyProgram;
} {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  const result = typeCheck(parsed.result, {}, info);
  return { errors: result.errors.map((e) => e.message), result, program: parsed.result };
}

const check = (source: string): string[] => run(source).errors;

describe("flow narrowing is consistent across passes (PR 2)", () => {
  const R = `type R = { kind: "a", v: string } | { kind: "b", v: number }`;

  it("a narrowed member access types precisely as a function argument", () => {
    // checkFunctionCallsInScope (Phase B) synths the arg; before PR 2 it used
    // the flat scope and saw `string | number`, mis-erroring against `string`.
    const errors = check(`
${R}
def takesString(s: string): void { }
def f(r: R): void {
  if (r.kind == "a") {
    takesString(r.v)
  }
}`);
    expect(errors).toEqual([]);
  });

  it("a narrowed member access types precisely as a return value", () => {
    // NOTE: g has an *annotated* return type, so this tests Phase B CHECKING,
    // not inference. Do not rewrite to an unannotated return and assert a
    // tightened inferred type — Phase A inference still uses scope.lookup
    // (flowEnv is unset during inferReturnTypes), so the inferred type stays
    // wide until PR 3. See "Notes for PR 3".
    const errors = check(`
${R}
def g(r: R): string {
  if (r.kind == "a") {
    return r.v
  }
  return "x"
}`);
    expect(errors).toEqual([]);
  });

  it("RHS of && sees the LHS narrowing", () => {
    // The right `r.v` is attached (1b) to a flow wrapped with the LHS
    // then-facts; before PR 2 the arg-check synths it flat → string | number.
    const errors = check(`
${R}
def takesStringReturnsBool(s: string): boolean { return true }
def h(r: R): void {
  let ok = r.kind == "a" && takesStringReturnsBool(r.v)
}`);
    expect(errors).toEqual([]);
  });
});

describe("flow graph identity + reassignment (PR 2 guards)", () => {
  const R = `type R = { kind: "a", v: string } | { kind: "b", v: number }`;

  it("GUARD: the flow graph is keyed on the AST nodes the checker sees", () => {
    // If a future AST rewrite between buildFlowGraphs and checkScopes breaks
    // node identity, narrowing silently falls back to scope.lookup — this fails
    // loudly instead. Grab the parsed `r` reference and assert it has a flow.
    const { result, program } = run(`
${R}
def f(r: R): void {
  if (r.kind == "a") {
    print(r.v)
  }
}`);
    let rRef: AgencyNode | undefined;
    for (const { node } of walkNodes(program.nodes)) {
      if (node.type === "variableName" && node.value === "r") {
        rRef = node;
      }
    }
    expect(rRef).toBeDefined();
    expect(result.flowEnv?.flowOf.get(rRef!)).toBeDefined();
  });

  it("PIN: a reassigned variable resolves to its declared type (no per-position)", () => {
    // assign nodes carry scope.lookup (the final declared type), so typeAt is
    // not flow-sensitive across reassignments yet. Pins current behavior; see
    // the reassigned-precision caveat in "Notes for PR 3".
    const errors = check(`
def f(): void {
  let x: number = 1
  x = 2
  let y: number = x
}`);
    expect(errors).toEqual([]);
  });
});
