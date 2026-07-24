import { describe, expect, it } from "vitest";
import { identifierSlots, REGISTERED_IDENTIFIER_KINDS } from "./identifierSlots.js";
import { EXPRESSION_NODE_TYPES } from "../types.js";
import type { AgencyNode } from "../types.js";

function slotsFor(node: unknown) {
  return identifierSlots(node as AgencyNode);
}

describe("identifierSlots completeness", () => {
  it("registers every expression node kind", () => {
    // The registry is a Record over AgencyNode["type"], so a missing kind
    // is a COMPILE error — that is the real enforcement and it fails by
    // name. This test covers the other direction: it catches a kind that
    // was added to the language and to the registry, but by someone who
    // did not think about whether it holds an identifier.
    const missing = EXPRESSION_NODE_TYPES.filter(
      (kind) => !REGISTERED_IDENTIFIER_KINDS.includes(kind),
    );
    expect(missing).toEqual([]);
  });

  it("returns no slots for an unknown node kind rather than throwing", () => {
    // Templates and tests can synthesize nodes outside the union.
    expect(slotsFor({ type: "notARealNodeKind" })).toEqual([]);
  });
});

describe("identifierSlots positions", () => {
  const loc = { line: 3, col: 7, start: 42, end: 48 };

  it("reads a plain variable reference", () => {
    expect(slotsFor({ type: "variableName", value: "helper", loc })).toEqual([
      { name: "helper", line: 3, col: 7, scopeOffset: 42, isCall: false },
    ]);
  });

  it("reads a call and marks it as one", () => {
    const slots = slotsFor({
      type: "functionCall",
      functionName: "helper",
      arguments: [],
      loc,
    });
    expect(slots).toEqual([
      { name: "helper", line: 3, col: 7, scopeOffset: 42, isCall: true },
    ]);
  });

  it("does not carry the node span as a length source", () => {
    // The slot exposes `name`, never end-start. A functionCall's loc
    // spans `helper(y)`, so a consumer using the span would paint the
    // arguments. Nothing in the slot makes that possible.
    const slots = slotsFor({
      type: "functionCall",
      functionName: "helper",
      arguments: [],
      loc: { line: 0, col: 0, start: 0, end: 999 },
    });
    expect(slots[0].name.length).toBe(6);
    expect(Object.keys(slots[0])).not.toContain("end");
  });
});

describe("identifierSlots exclusions", () => {
  const loc = { line: 1, col: 2, start: 10, end: 14 };

  it("skips `null`, which the parser represents as a variable name", () => {
    expect(slotsFor({ type: "variableName", value: "null", loc })).toEqual([]);
  });

  it("skips nodes with no loc — this is what the valueAccess gap looks like", () => {
    // walkNodes descends into a valueAccess base, so an unlocated
    // variableName really does arrive here. The guard is on loc rather
    // than on node kind, so these start producing slots automatically
    // once the parser carries positions for them.
    expect(slotsFor({ type: "variableName", value: "obj" })).toEqual([]);
    expect(
      slotsFor({ type: "functionCall", functionName: "invoke", arguments: [] }),
    ).toEqual([]);
  });

  it("skips a template hole used as a callee", () => {
    expect(
      slotsFor({
        type: "functionCall",
        functionName: { type: "hole", name: "name" },
        arguments: [],
        loc,
      }),
    ).toEqual([]);
  });

  it("skips declaration sites, which the grammar already colours", () => {
    expect(
      slotsFor({
        type: "function",
        functionName: "helper",
        parameters: [],
        body: [],
        loc,
      }),
    ).toEqual([]);
    expect(
      slotsFor({ type: "graphNode", nodeName: "main", parameters: [], body: [], loc }),
    ).toEqual([]);
  });
});
