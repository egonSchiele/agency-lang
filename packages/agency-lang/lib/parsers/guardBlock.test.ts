import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import type { GuardBlock } from "../types/guardBlock.js";

/** Parse a program and return the value of the first declaration in
 *  `node main()`, which the tests arrange to be a guardBlock. */
function firstDeclValue(src: string): any {
  const r = parseAgency(src, {}, false);
  expect(r.success).toBe(true);
  if (!r.success) return null;
  const main: any = r.result.nodes.find((n: any) => n.type === "graphNode");
  const decl = main.body.find((s: any) => s.type === "assignment");
  return decl.value;
}

describe("guardBlockParser", () => {
  it("carries the head as a verbatim call-style argument list, source order preserved", () => {
    const g1: GuardBlock = firstDeclValue(
      "node main() { const r = guard(cost: $1) { return 1 }\n return r }",
    );
    expect(g1.type).toBe("guardBlock");
    expect(g1.arguments.map((a: any) => a.name)).toEqual(["cost"]);

    const g2: GuardBlock = firstDeclValue(
      "node main() { const r = guard(time: 5m, cost: $1) { return 1 }\n return r }",
    );
    expect(g2.arguments.map((a: any) => a.name)).toEqual(["time", "cost"]);

    const g3: GuardBlock = firstDeclValue(
      "node main() { const r = guard() { return 1 }\n return r }",
    );
    expect(g3.arguments).toEqual([]);
    expect(g3.body).toHaveLength(1);
  });

  it("does not validate the head — unknown, duplicate, and positional args parse and are forwarded", () => {
    // Validation is the checker's job, against _guard's signature after
    // desugaring — the same diagnostics a bad call always got. The
    // parser just carries the list.
    const unknown: GuardBlock = firstDeclValue(
      "node main() { const r = guard(budget: $1) { return 1 }\n return r }",
    );
    expect(unknown.type).toBe("guardBlock");
    expect((unknown.arguments[0] as any).name).toBe("budget");

    const positional: GuardBlock = firstDeclValue(
      "node main() { const r = guard($1) { return 1 }\n return r }",
    );
    expect(positional.type).toBe("guardBlock");
    expect(positional.arguments).toHaveLength(1);

    const dup: GuardBlock = firstDeclValue(
      "node main() { const r = guard(cost: $1, cost: $2) { return 1 }\n return r }",
    );
    expect(dup.type).toBe("guardBlock");
    expect(dup.arguments).toHaveLength(2);
  });

  it("parses in return position", () => {
    const r = parseAgency(
      "node main() { return guard(cost: $1) { return 1 } }",
      {},
      false,
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const main: any = r.result.nodes.find((n: any) => n.type === "graphNode");
    const ret = main.body.find((s: any) => s.type === "returnStatement");
    expect(ret.value.type).toBe("guardBlock");
  });

  it("parses in statement position", () => {
    const r = parseAgency(
      "node main() { guard(time: 5ms) { doWork() }\n return 1 }",
      {},
      false,
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const main: any = r.result.nodes.find((n: any) => n.type === "graphNode");
    const stmt = main.body.find((s: any) => s.type === "guardBlock");
    expect(stmt).toBeDefined();
  });

  it("parses the legacy `as` form to a node deep-equal to the as-less form", () => {
    const withAs: GuardBlock = firstDeclValue(
      "node main() { const r = guard(cost: $1) as { return 1 }\n return r }",
    );
    const without: GuardBlock = firstDeclValue(
      "node main() { const r = guard(cost: $1) { return 1 }\n return r }",
    );
    const strip = (n: any) => JSON.parse(JSON.stringify(n, (k, v) => (k === "loc" ? undefined : v)));
    expect(strip(withAs)).toEqual(strip(without));
  });

  it("does not claim identifiers with a guard prefix (word boundary)", () => {
    const r = parseAgency(
      "def guardrails(x: number): number { return x }\nnode main() { const r = guardrails(1)\n return r }",
      {},
      false,
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const main: any = r.result.nodes.find((n: any) => n.type === "graphNode");
    const decl = main.body.find((s: any) => s.type === "assignment");
    expect(decl.value.type).not.toBe("guardBlock");
  });

  it("does not claim a call with no trailing block (fall-through)", () => {
    const r = parseAgency(
      "def guard(x: number): number { return x }\nnode main() { const g = guard(1)\n return g }",
      {},
      false,
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const main: any = r.result.nodes.find((n: any) => n.type === "graphNode");
    const decl = main.body.find((s: any) => s.type === "assignment");
    expect(decl.value.type).not.toBe("guardBlock");
  });
});
