import { describe, it, expect } from "vitest";
import { bodySlots } from "./bodySlots.js";
import { parseAgency } from "../parser.js";
import { walkNodesArray } from "./node.js";
import type { AgencyNode } from "../types.js";

describe("bodySlots — guardBlock", () => {
  it("exposes its body slot and round-trips through write", () => {
    const body = [{ type: "returnStatement", value: null }];
    const node = {
      type: "guardBlock",
      arguments: [],
      body,
    } as any;
    const slots = bodySlots(node);
    expect(slots.map((s) => s.body)).toEqual([body]);
    const rewritten = slots[0].write(node, []) as any;
    expect(rewritten.body).toEqual([]);
    expect(rewritten.type).toBe("guardBlock");
  });
});

describe("codeLiteral is not a body-bearing node", () => {
  it("quoted code stays quoted: no body slots, and the walker never yields body nodes", () => {
    const parsed = parseAgency(
      `node main() {\n  const t = [| print(1) |]\n}\n`,
      {},
      false,
      false,
    );
    if (!parsed.success) throw new Error(parsed.message);
    const yielded = walkNodesArray(parsed.result.nodes).map((visit) => visit.node);
    const lit = yielded.find((node) => node.type === "codeLiteral");
    expect(lit).toBeDefined();
    expect(bodySlots(lit as AgencyNode)).toEqual([]);
    // The only print in the file is the quoted one — the walker must not see it.
    expect(
      yielded.some(
        (node) =>
          node.type === "functionCall" &&
          (node as { functionName?: unknown }).functionName === "print",
      ),
    ).toBe(false);
  });
});
