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
  it("parses each head shape with fields and argOrder from source order", () => {
    const g1: GuardBlock = firstDeclValue(
      "node main() { const r = guard(cost: $1) { return 1 }\n return r }",
    );
    expect(g1.type).toBe("guardBlock");
    expect(g1.cost).not.toBeNull();
    expect(g1.time).toBeNull();
    expect(g1.label).toBeNull();
    expect(g1.argOrder).toEqual(["cost"]);

    const g2: GuardBlock = firstDeclValue(
      "node main() { const r = guard(time: 5m, cost: $1) { return 1 }\n return r }",
    );
    expect(g2.argOrder).toEqual(["time", "cost"]);
    expect(g2.time).not.toBeNull();
    expect(g2.cost).not.toBeNull();

    const g3: GuardBlock = firstDeclValue(
      'node main() { const r = guard(label: "x") { return 1 }\n return r }',
    );
    expect(g3.label).not.toBeNull();
    expect(g3.argOrder).toEqual(["label"]);

    const g4: GuardBlock = firstDeclValue(
      "node main() { const r = guard() { return 1 }\n return r }",
    );
    expect(g4.cost).toBeNull();
    expect(g4.time).toBeNull();
    expect(g4.label).toBeNull();
    expect(g4.argOrder).toEqual([]);
    expect(g4.body).toHaveLength(1);
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

  it("does not claim malformed heads — positional, unknown, or duplicate args fall through", () => {
    // The position-sensitive rule applied consistently: only the exact
    // well-formed shape is claimed. A malformed head falls through to
    // the ordinary grammar, where `guard` is an unresolved name and
    // the EXISTING resolution diagnostics take over downstream.
    for (const head of ["$1", "budget: $1", "cost: $1, cost: $2"]) {
      const r = parseAgency(
        `node main() { const r = guard(${head}) { return 1 }\n return r }`,
        {},
        false,
      );
      if (!r.success) continue; // a parse failure is fine too
      const main: any = r.result.nodes.find((n: any) => n.type === "graphNode");
      const decl = main.body.find((s: any) => s.type === "assignment");
      expect(decl.value.type).not.toBe("guardBlock");
    }
  });
});
