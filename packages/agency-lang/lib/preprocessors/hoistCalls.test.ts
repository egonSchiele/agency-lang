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

describe("hoistCallsInScope: control flow", () => {
  it("hoists an if condition call to before the if", () => {
    const body = stmts(
      hoistCallsInScope(
        bodyOf(`
def f(n: number): number {
  if (score(n) > 3) { return 1 }
  return 0
}`),
      ),
    ) as any[];
    expect(body[0].value.functionName).toBe("score");
    expect(body[1].type).toBe("ifElse");
  });

  it("hoists a for iterable call to before the loop", () => {
    const body = stmts(
      hoistCallsInScope(
        bodyOf(`
def f(): number {
  let total = 0
  for (item in getItems()) { total = total + item }
  return total
}`),
      ),
    ) as any[];
    const idx = body.findIndex((n) => n.value?.functionName === "getItems");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(body.findIndex((n) => n.type === "forLoop"));
  });

  it("rewrites a while with a condition call into while(true) + if/else-break", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(): number {
  let i = 0
  while (check(i) < 5) { i = i + 1 }
  return i
}`),
    );
    const wl = (stmts(body) as any[]).find((n) => n.type === "whileLoop");
    expect(wl.condition).toMatchObject({ type: "boolean", value: true });
    const wb = stmts(wl.body) as any[];
    expect(wb[0].value.functionName).toBe("check");
    expect(wb[1].type).toBe("ifElse");
    expect(wb[1].thenBody.length).toBeGreaterThan(0);
    expect(wb[1].elseBody[0]).toMatchObject({ type: "keyword", value: "break" });
  });

  it("leaves a call-free while condition untouched", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(): number {
  let i = 0
  while (i < 5) { i = i + 1 }
  return i
}`),
    );
    const wl = (stmts(body) as any[]).find((n) => n.type === "whileLoop");
    expect(wl.condition.type).not.toBe("boolean");
  });
});

describe("hoistCallsInScope: boundaries", () => {
  it("does not descend into a try operand at all", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(url: string): any {
  const t = try parse(fetchBody(url))
  return t
}`),
    );
    expect(temps(body)).toHaveLength(0);
  });

  it("hoists the left of a short-circuit but not the right", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(): boolean {
  return probe(1) > 0 && probe(2) > 1
}`),
    );
    expect(temps(body)).toHaveLength(1);
  });

  it("treats the whole catch expression as opaque", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(x: any): any {
  return risky(deep(x)) catch fallback(x)
}`),
    );
    expect(temps(body)).toHaveLength(0);
  });

  it("hoists a pipe input but not pipe stages", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(x: any): any {
  return load(x) |> clean |> summarize
}`),
    );
    // load(x) is the deep-left input of the nested |> chain; it is also
    // non-tail (the tail is the outer pipe), so it hoists. Stages stay.
    const t = temps(body) as any[];
    expect(t.map((n) => n.value.functionName)).toEqual(["load"]);
  });

  it("fork branches: hoists WITHIN the branch body, nothing crosses out", () => {
    const body = hoistCallsInScope(
      bodyOf(`
def f(): any {
  return fork [expensive(seed(x)) for x in [1, 2]]
}`),
    );
    expect(temps(body)).toHaveLength(0);
    const flat = JSON.stringify(body);
    expect(flat).toContain("__hoist_0");
    expect(flat).toContain("seed");
  });

  it("skips handler bodies entirely; the handle body still hoists", () => {
    const src = `
node main() {
  handle {
    return work(prep(1))
  } with (data) {
    return match(data.effect) {
      _ => approve(annotate(data))
    }
  }
}`;
    const parsed = parseAgency(src, {}, true);
    if (!parsed.success) throw new Error(parsed.message);
    const main = (parsed.result.nodes as any[]).find(
      (n) => n.type === "graphNode",
    );
    const out = hoistCallsInScope(main.body);
    const handle = (stmts(out) as any[]).find((n) => n.type === "handleBlock");
    expect(handle).toBeDefined();
    // Positive: the handle BODY hoisted prep into a temp.
    const handleBodyFlat = JSON.stringify(handle.body);
    expect(handleBodyFlat).toContain("__hoist_");
    expect(handleBodyFlat).toContain("prep");
    // Negative: the with-body subtree is untouched — annotate remains a
    // call argument and no temp name appears anywhere inside it.
    const handlerFlat = JSON.stringify(handle.handler);
    expect(handlerFlat).toContain("annotate");
    expect(handlerFlat).not.toContain("__hoist_");
  });

  it("with-modified statements are opaque", () => {
    // `<stmt> with approve` wraps one statement; hoisting a temp out of
    // it would move the call outside the modifier's approval region,
    // and the single-statement slot cannot hold two statements anyway.
    const body = hoistCallsInScope(
      bodyOf(`
def f(x: any): any {
  const text = dangerous(prep(x)) with approve
  return text
}`),
    );
    expect(temps(body)).toHaveLength(0);
  });

  it("is idempotent", () => {
    const once = hoistCallsInScope(
      bodyOf(`
def f(n: number): number {
  if (score(n) > 3) { return outer(inner(1)) }
  return 0
}`),
    );
    const twice = hoistCallsInScope(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

describe("fixture shape pins (S6): the flagship fixtures exercise hoisted shapes", () => {
  // The resume-regression fixtures only prove anything if their llm
  // options argument actually becomes a hoisted temp. Pinning that here
  // makes the guarantee permanent — a one-time unwire-and-rerun proves
  // it once, this proves it on every CI run.
  it("resume-regression-args: the llm options argument is a __hoist temp reference", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../../tests/agency/hoist/resume-regression-args.agency", import.meta.url),
      "utf8",
    );
    const parsed = parseAgency(src, {}, true);
    if (!parsed.success) throw new Error(parsed.message);
    const main = (parsed.result.nodes as any[]).find((n) => n.type === "graphNode");
    const out = hoistCallsInScope(main.body) as any[];
    const t = temps(out) as any[];
    expect(t).toHaveLength(1);
    expect(t[0].value.functionName).toBe("myOptions");
    const llmStmt = (stmts(out) as any[]).find(
      (n) => n.value?.functionName === "llm",
    );
    const optionsArg = llmStmt.value.arguments[1];
    expect(optionsArg).toMatchObject({ type: "variableName", value: t[0].variableName });
  });
});
