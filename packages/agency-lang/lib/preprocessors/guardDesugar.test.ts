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
