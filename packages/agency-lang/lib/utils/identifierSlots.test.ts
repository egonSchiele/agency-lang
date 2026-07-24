import { describe, expect, it } from "vitest";
import { identifierSlots, IDENTIFIER_BEARING_KINDS } from "./identifierSlots.js";
import { parseAgency } from "../parser.js";
import { walkNodes } from "./node.js";
import type { AgencyNode } from "../types.js";

function slotsFor(node: unknown) {
  return identifierSlots(node as AgencyNode);
}

/** Synthetic nodes of each identifier-bearing kind, shaped as the parser
 *  produces them. Used to prove the registry entry still does something. */
const SAMPLE_NODES: Record<(typeof IDENTIFIER_BEARING_KINDS)[number], unknown> = {
  variableName: {
    type: "variableName",
    value: "helper",
    loc: { line: 0, col: 0, start: 0, end: 6 },
  },
  functionCall: {
    type: "functionCall",
    functionName: "helper",
    arguments: [],
    loc: { line: 0, col: 0, start: 0, end: 8 },
  },
};

describe("identifierSlots completeness", () => {
  // NOTE on what enforces what. The registry is
  // `{ [K in AgencyNode["type"]]: SlotExtractor<K> }`, so a node kind
  // added to the language fails to COMPILE until it is registered, and
  // each extractor sees its own node type so an AST field rename is also
  // a compile error. Those are the real guarantees; neither needs a test.
  //
  // What the compiler cannot catch is an entry that is present but
  // wrong — flipped to `none`, or reading a field that exists but is not
  // the name. That is what the two tests below are for.

  it.each(IDENTIFIER_BEARING_KINDS)(
    "%s still produces a slot",
    (kind) => {
      // Fails if someone sets this entry to `none`, which compiles fine
      // and would silently stop coloring that whole node kind.
      const slots = slotsFor(SAMPLE_NODES[kind]);
      expect(slots.length).toBe(1);
      expect(slots[0].name).toBe("helper");
    },
  );

  it("finds every located name in a real parsed file", () => {
    // The corpus check: parse real code, collect every node the walk
    // reaches that carries both a name and a position, and assert the
    // table accounts for all of them. Fails if an extractor starts
    // dropping nodes it used to handle — a guard the synthetic cases
    // above cannot give, since they never exercise the walk.
    const source = [
      `def helper(x: number): number {`,
      `  return x + 1`,
      `}`,
      ``,
      `node main() {`,
      `  const f = helper`,
      `  const y = f(3)`,
      `  print("interpolated \${helper(y)}")`,
      `  for (item in [1, 2]) {`,
      `    print(item)`,
      `  }`,
      `}`,
    ].join("\n");

    const parsed = parseAgency(source, {}, false);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const located: string[] = [];
    for (const { node } of walkNodes(parsed.result.nodes)) {
      const any = node as { type: string; loc?: unknown; value?: unknown; functionName?: unknown };
      if (!any.loc) continue;
      if (any.type === "variableName" && any.value !== "null") {
        located.push(String(any.value));
      }
      if (any.type === "functionCall" && typeof any.functionName === "string") {
        located.push(any.functionName);
      }
    }

    const found = [...walkNodes(parsed.result.nodes)].flatMap(({ node }) =>
      identifierSlots(node).map((slot) => slot.name),
    );

    expect(located.length).toBeGreaterThan(5);
    expect(found.sort()).toEqual(located.sort());
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

  it("skips declaration sites, which the grammar already colors", () => {
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
