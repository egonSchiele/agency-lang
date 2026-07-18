import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { desugarGuardsInBody } from "./guardDesugar.js";

function mainBody(src: string): any[] {
  const r = parseAgency(src, {}, false);
  expect(r.success).toBe(true);
  if (!r.success) return [];
  const main: any = r.result.nodes.find((n: any) => n.type === "graphNode");
  return main.body;
}

describe("desugarGuardsInBody", () => {
  it("rewrites a guardBlock declaration value into the legacy __guard call shape", () => {
    const body = desugarGuardsInBody(
      mainBody("node main() { const r = guard(cost: $1) { return 1 }\n return r }"),
    );
    const decl: any = body.find((s: any) => s.type === "assignment");
    const call = decl.value;
    expect(call.type).toBe("functionCall");
    expect(call.functionName).toBe("_guard");
    expect(call.arguments).toHaveLength(1);
    expect(call.arguments[0]).toMatchObject({ type: "namedArgument", name: "cost" });
    expect(call.block).toMatchObject({ type: "blockArgument", inline: false, params: [] });
    expect(call.block.body).toHaveLength(1);
  });

  it("forwards the head verbatim in source order — including args _guard will reject", () => {
    const body = desugarGuardsInBody(
      mainBody("node main() { const r = guard(time: 5m, cost: $1) { return 1 }\n return r }"),
    );
    const call: any = (body.find((s: any) => s.type === "assignment") as any).value;
    expect(call.arguments.map((a: any) => a.name)).toEqual(["time", "cost"]);

    const bad = desugarGuardsInBody(
      mainBody("node main() { const r = guard(budget: $1) { return 1 }\n return r }"),
    );
    const badCall: any = (bad.find((s: any) => s.type === "assignment") as any).value;
    expect(badCall.functionName).toBe("_guard");
    expect(badCall.arguments.map((a: any) => a.name)).toEqual(["budget"]);
  });

  it("desugars nested guards, children first", () => {
    const body = desugarGuardsInBody(
      mainBody(
        "node main() { const r = guard(cost: $2) { const inner = guard(cost: $1) { return 1 }\n return inner }\n return r }",
      ),
    );
    const outer: any = (body.find((s: any) => s.type === "assignment") as any).value;
    expect(outer.functionName).toBe("_guard");
    const innerDecl = outer.block.body.find((s: any) => s.type === "assignment");
    expect(innerDecl.value.functionName).toBe("_guard");
    expect(innerDecl.value.block.type).toBe("blockArgument");
  });

  it("desugars statement-position and return-position guards", () => {
    const body = desugarGuardsInBody(
      mainBody("node main() { guard(time: 5ms) { doWork() }\n return guard(cost: $1) { return 2 } }"),
    );
    const stmt: any = body.find((s: any) => s.type === "functionCall");
    expect(stmt.functionName).toBe("_guard");
    const ret: any = body.find((s: any) => s.type === "returnStatement");
    expect(ret.value.functionName).toBe("_guard");
  });
});

/** Parse a whole program and desugar all of it (defs and nodes). */
function desugarSource(src: string): any[] {
  const r = parseAgency(src, {}, false);
  expect(r.success).toBe(true);
  if (!r.success) return [];
  return desugarGuardsInBody(r.result.nodes) as any[];
}

const STRING_T = { type: "primitiveType", value: "string" };

describe("guardDesugar — declaredYieldType stamping (#580)", () => {
  it("stamps successType from an annotated const assignment (def type differs, so the source is visible)", () => {
    // def returns number; the annotation says string. Only the
    // annotation can produce the string stamp.
    const nodes = desugarSource(
      'def f(): number {\n  const r: Result<string> = guard(cost: $1) {\n    return "x"\n  }\n  return 1\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.functionName).toBe("_guard");
    expect(assign.value.block.declaredYieldType).toEqual(STRING_T);
  });

  it("stamps a `let` annotation the same way", () => {
    const nodes = desugarSource(
      'def f(): number {\n  let r: Result<string> = guard(cost: $1) {\n    return "x"\n  }\n  return 1\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.block.declaredYieldType).toEqual(STRING_T);
  });

  it("stamps nothing on an unannotated assignment", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r = guard(cost: $1) {\n    return "x"\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.block.declaredYieldType).toBeUndefined();
  });

  it("stamps nothing from a non-Result annotation", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: string = guard(cost: $1) {\n    return "x"\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.block.declaredYieldType).toBeUndefined();
  });

  it("stamps a return-position guard from the enclosing def's declared Result return", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  return guard(cost: $1) {\n    return "x"\n  }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const ret = def.body.find((node: any) => node.type === "returnStatement");
    expect(ret.value.block.declaredYieldType).toEqual(STRING_T);
  });

  it("stamps a return-position guard inside a NODE from the node's declared return", () => {
    const nodes = desugarSource(
      'node main(): Result<string> {\n  return guard(cost: $1) {\n    return "x"\n  }\n}\n',
    );
    const graphNode = nodes.find(
      (node: any) => node.type === "graphNode",
    ) as any;
    const ret = graphNode.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(ret.value.block.declaredYieldType).toEqual(STRING_T);
  });

  it("a return-position guard inside an `if` INHERITS the def target (positive counterpart to the resets)", () => {
    const nodes = desugarSource(
      'def f(cond: boolean): Result<string> {\n  if (cond) {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n  return guard(cost: $1) { return "y" }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const ifNode = def.body.find((node: any) => node.type === "ifElse");
    const innerReturn = ifNode.thenBody.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(innerReturn.value.block.declaredYieldType).toEqual(STRING_T);
  });

  it("does NOT stamp a return-position guard inside a fork branch (block boundary resets)", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  const r = fork([1]) as n {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n  return guard(cost: $1) { return "y" }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const forkAssign = def.body.find((node: any) => node.type === "assignment");
    const innerReturn = forkAssign.value.block.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(innerReturn.value.block.declaredYieldType).toBeUndefined();
  });

  it("does NOT stamp a return-position guard inside an inline handler body (handler boundary resets)", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  handle {\n  return guard(cost: $1) { return "ok" }\n  } with (i) {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const handle = def.body.find((node: any) => node.type === "handleBlock");
    const handlerReturn = handle.handler.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(handlerReturn.value.block.declaredYieldType).toBeUndefined();
    // The guarded body itself INHERITS (a return there returns from f):
    const bodyReturn = handle.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(bodyReturn.value.block.declaredYieldType).toEqual(STRING_T);
  });

  it("does NOT stamp a return-position guard inside a finalize body (finalize boundary resets)", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  return guard(cost: $1) { return "ok" }\n\n  finalize {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const finalize = def.body.find(
      (node: any) => node.type === "finalizeBlock",
    );
    const finReturn = finalize.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(finReturn.value.block.declaredYieldType).toBeUndefined();
  });

  it("composes: a stamped guard block becomes the return target for its own body", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: Result<Result<string>> = guard(cost: $1) {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const outer = def.body.find(
      (node: any) => node.type === "assignment",
    ).value;
    expect(outer.block.declaredYieldType.type).toBe("resultType");
    const innerReturn = outer.block.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(innerReturn.value.block.declaredYieldType).toEqual(STRING_T);
  });

  it("unwraps only successType from Result<T, E>", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: Result<number, string> = guard(cost: $1) {\n    return 1\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "number",
    });
  });

  it("a statement-position guard stamps nothing", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  guard(cost: $1) {\n    return "x"\n  }\n  return guard(cost: $1) { return "y" }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const stmt = def.body.find(
      (node: any) =>
        node.type === "functionCall" && node.functionName === "_guard",
    );
    expect(stmt.block.declaredYieldType).toBeUndefined();
  });

  it("a second desugar run leaves the stamps unchanged (double-run stability)", () => {
    const nodes = desugarSource(
      'def f(): number {\n  const r: Result<string> = guard(cost: $1) {\n    return "x"\n  }\n  return 1\n}\n',
    );
    const before = JSON.stringify(nodes);
    desugarGuardsInBody(nodes as any);
    expect(JSON.stringify(nodes)).toBe(before);
  });
});
