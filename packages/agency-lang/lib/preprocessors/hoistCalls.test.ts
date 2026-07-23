import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { hoistCallsInScope } from "./hoistCalls.js";
import type { AgencyNode } from "../types.js";

function bodyOf(src: string): AgencyNode[] {
  const parsed = parseAgency(src, {}, true);
  if (!parsed.success) throw new Error(parsed.message);
  const fn = (parsed.result.nodes as any[]).find(
    (n) => n.type === "function" || n.type === "graphNode",
  );
  return fn.body;
}

const stmts = (body: AgencyNode[]) =>
  body.filter((n: any) => n.type !== "comment" && n.type !== "newLine");
const temps = (body: AgencyNode[]) =>
  stmts(body).filter((n: any) => n.variableName?.startsWith("__hoist"));

describe("hoistCallsInScope: statements", () => {
  it("hoists a call in argument position into a const temp", () => {
    const body = stmts(
      hoistCallsInScope(
        bodyOf(`
def f(): string {
  return outer(inner(1))
}`),
      ),
    ) as any[];
    expect(body.map((n) => n.type)).toEqual(["assignment", "returnStatement"]);
    expect(body[0].declKind).toBe("const");
    expect(body[0].variableName).toBe("__hoist_0");
    expect(body[0].value.type).toBe("functionCall");
    expect(body[0].value.functionName).toBe("inner");
    expect(body[1].value.functionName).toBe("outer");
  });

  it("does not mutate its input", () => {
    const original = bodyOf(`
def f(): string {
  return outer(inner(1))
}`);
    const snapshot = JSON.stringify(original);
    hoistCallsInScope(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("unrolls nested calls innermost-first, left to right", () => {
    const body = temps(
      hoistCallsInScope(
        bodyOf(`
def f(): string {
  return combine(prepare(fetchRaw()), enrich())
}`),
      ),
    ) as any[];
    expect(body.map((n) => n.value.functionName)).toEqual([
      "fetchRaw",
      "prepare",
      "enrich",
    ]);
  });

  it("the statement tail call is not hoisted", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(): string {
  const x = solo(1)
  return x
}`),
    );
    expect(temps(body)).toHaveLength(0);
  });

  it("steps over comments between statements", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(): string {
  // a comment sits here
  return outer(inner(1))
}`),
    );
    expect(temps(body)).toHaveLength(1);
  });

  it("copies loc onto every synthesized statement", () => {
    const body = temps(
      hoistCallsInScope(
        bodyOf(`
def f(): string {
  return outer(inner(1))
}`),
      ),
    ) as any[];
    expect(body[0].loc).toBeDefined();
    expect(body[0].loc.line).toBeGreaterThan(0);
  });

  it("numbering is per frame-owning scope, not per statement list", () => {
    // The loop body shares the function frame; frame locals are flat, so
    // a body-level __hoist_0 would clobber the iterable temp the loop
    // re-reads on resume.
    const body = hoistCallsInScope(
      bodyOf(`
def f(): number {
  let total = 0
  for (item in getItems()) { total = total + weigh(item, scale()) }
  return total
}`),
    );
    const names = JSON.stringify(body).match(/__hoist_\d+/g) ?? [];
    expect(names).toContain("__hoist_0");
    expect(names).toContain("__hoist_1");
    expect(new Set(names).size).toBeGreaterThanOrEqual(2);
  });

  it("numbering skips user-declared __hoist names (seeding is the guard; no lint rule exists)", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(): string {
  const __hoist_0 = "user owned"
  return outer(inner(1))
}`),
    );
    const temp = (stmts(body) as any[]).find(
      (n) => n.value?.functionName === "inner",
    );
    expect(temp.variableName).toBe("__hoist_1");
  });

  it("hoists calls inside object literals, arrays, spreads, and string interpolation", () => {
    const body = temps(
      hoistCallsInScope(
        bodyOf(`
def f(): string {
  const opts = { tools: [...searchTools()], label: "x: \${render(1)}" }
  return llm("q", opts)
}`),
      ),
    ) as any[];
    expect(body.map((n) => n.value.functionName)).toEqual([
      "searchTools",
      "render",
    ]);
  });

  it("a temp emitted inside a block body lands in that body, never the enclosing one", () => {
    // Comprehensions desugar at parse time to map(...) with a block
    // argument; the per-item call must hoist INSIDE the block body
    // (evaluated per item), never to the enclosing body (evaluated once).
    const body = hoistCallsInScope(
      bodyOf(`
def f(xs: number[]): number[] {
  return [scaleBy(perItem(x)) for x in xs]
}`),
    );
    expect(temps(body)).toHaveLength(0);
    const flat = JSON.stringify(body);
    expect(flat).toContain("__hoist_0");
    expect(flat).toContain("perItem");
  });
});
