import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { walkNodesArray } from "../utils/node.js";
import type { AgencyNode } from "../types.js";
import type { Splice } from "../types/splice.js";

function parseTemplate(source: string) {
  const result = parseAgency(source, {}, false, false);
  if (!result.success) {
    throw new Error(result.message ?? "parse failed");
  }
  return result.result;
}

/** There is no findNodesOfType helper in this codebase. This is the same
 *  construction lib/utils/holes.ts:findHoles uses — spread, map, filter.
 *  Copy that shape, not a for-loop with an accumulator. */
function nodesOfType(nodes: AgencyNode[], type: string): AgencyNode[] {
  return [...walkNodesArray(nodes)].map((visit) => visit.node).filter((node) => node.type === type);
}

function splicesIn(source: string): Splice[] {
  return nodesOfType(parseTemplate(source).nodes, "splice") as Splice[];
}

describe("splice parsing", () => {
  it("parses a splice in declaration position", () => {
    const [splice] = splicesIn(`$( makeGetters(["a"]) )\n\nnode main() {\n  return 1\n}\n`);
    expect(splice.position).toBe("decl");
    expect(splice.expression.type).toBe("functionCall");
  });

  it("parses a splice in expression position", () => {
    const [splice] = splicesIn(`node main() {\n  const x = $( buildTable(3) )\n  return x\n}\n`);
    expect(splice.position).toBe("expr");
  });

  it("treats a top-level const assignment as an expression splice", () => {
    // Reaches the splice through baseAtom, not topLevelSpliceParser.
    const [splice] = splicesIn(`const routes = $( build() )\n`);
    expect(splice.position).toBe("expr");
  });

  it("treats a bare splice inside a node body as a statement splice", () => {
    // CHANGED deliberately. This used to be "expr", which meant a
    // generator returning statements was refused in the one place it is
    // most useful. Statement position accepts the kinds a statements hole
    // already accepts.
    const [splice] = splicesIn(`node main() {\n  $( makeThings() )\n  return 1\n}\n`);
    expect(splice.position).toBe("statement");
  });

  it("parses a splice whose argument is a code literal", () => {
    const [splice] = splicesIn(`$( wrap([| print("x") |]) )\n`);
    expect(splice.position).toBe("decl");
  });

  it("parses nested parentheses in the spliced expression", () => {
    const [splice] = splicesIn(`node main() {\n  const x = $( f(g(1), h(2)) )\n  return x\n}\n`);
    expect(splice.expression.type).toBe("functionCall");
  });

  it("finds two splices in one file", () => {
    // Multiple splices are the normal case for the motivating use, and they
    // are where grafting breaks: a decl splice spreads N nodes and shifts
    // the index of every splice after it.
    const found = splicesIn(`$( first() )\n\n$( second() )\n\nnode main() {\n  return 1\n}\n`);
    expect(found).toHaveLength(2);
  });

  it("populates loc, which error attribution depends on", () => {
    const [splice] = splicesIn(`$( makeGetters(["a"]) )\n`);
    expect(splice.loc).toBeDefined();
    expect(typeof splice.loc?.line).toBe("number");
  });

  it("rejects an empty splice", () => {
    expect(parseAgency(`$( )\n`, {}, false, false).success).toBe(false);
  });

  it("leaves a dollar-paren inside a string alone", () => {
    expect(splicesIn(`node main() {\n  return "cost: $( 5 )"\n}\n`)).toEqual([]);
  });

  it("does not treat a splice inside a code literal as a host splice", () => {
    // A splice inside [| |] is template text belonging to the generated
    // program. codeLiteral is a walker leaf, so the host walk must not
    // yield it.
    expect(splicesIn(`const tpl = [| $( f() ) |]\n`)).toEqual([]);
  });

  it("descends into the spliced expression", () => {
    // THE leaf-ness test. Every other test above finds the splice through
    // its PARENT's slot and passes identically whether the splice is a leaf
    // or not. Tasks 4, 7, and 8 all need the walker to see inside. This
    // fails immediately on a `splice: true` leaf ruling.
    const calls = nodesOfType(parseTemplate(`$( f(g(1)) )\n`).nodes, "functionCall");
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("splice positions", () => {
  function spliceIn(source: string): Splice {
    const found = [...walkNodesArray(parseTemplate(source).nodes)]
      .map((visit) => visit.node)
      .find((node) => node.type === "splice");
    if (!found) throw new Error(`no splice in: ${source}`);
    return found as Splice;
  }

  it("stamps statement position on a splice occupying a whole statement", () => {
    expect(spliceIn("node main() {\n  $( gen() )\n}\n").position).toBe("statement");
  });

  it("leaves a splice inside an expression as expr", () => {
    expect(spliceIn("node main() {\n  const x = $( gen() )\n}\n").position).toBe("expr");
  });

  it("still stamps decl on a top-level splice", () => {
    // The new wrapper must not disturb the position it sits beside.
    expect(spliceIn("$( gen() )\n\nnode main() { print(1) }\n").position).toBe("decl");
  });
});
