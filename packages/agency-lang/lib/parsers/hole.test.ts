import { describe, it, expect } from "vitest";
import { holeParser } from "./parsers.js";
import { parseAgency } from "../parser.js";
import { walkNodesArray } from "../utils/node.js";
import { Hole } from "../types.js";

function parses(source: string): boolean {
  return parseAgency(source, {}, false, false).success;
}

function firstHole(source: string): Hole {
  const ast = parseAgency(source, {}, false, false);
  if (!ast.success) throw new Error(ast.message);
  const found = [...walkNodesArray(ast.result.nodes)]
    .map((visit) => visit.node)
    .find((node) => node.type === "hole");
  if (!found) throw new Error(`no hole found in: ${source}`);
  return found as Hole;
}

describe("holeParser", () => {
  it("parses a bare hole", () => {
    const r = holeParser("#prompt");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "hole",
      name: "prompt",
      sort: "expr",
      splice: false,
    });
  });

  it("parses a type annotation", () => {
    const r = holeParser("#prompt: string");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      typeAnnotation: { type: "primitiveType", value: "string" },
    });
  });

  it("parses a compound type annotation", () => {
    const r = holeParser("#items: string[] | null");
    expect(r.success).toBe(true);
  });

  it("rejects a space after the sigil", () => {
    expect(holeParser("# prompt").success).toBe(false);
  });

  it("rejects a hole with no name", () => {
    expect(holeParser("#").success).toBe(false);
  });

  it("rejects a name starting with a digit", () => {
    expect(holeParser("#123").success).toBe(false);
  });
});

describe("hole sort by position", () => {
  it("bare hole on its own line is a statements hole", () => {
    expect(firstHole(`node main() {\n  #setup\n}\n`).sort).toBe("statements");
  });

  it("hole in a call argument is an expr hole", () => {
    expect(firstHole(`node main() {\n  f(#setup)\n}\n`).sort).toBe("expr");
  });

  it("hole on the right of an assignment is an expr hole", () => {
    expect(firstHole(`node main() {\n  const x = #setup\n}\n`).sort).toBe("expr");
  });

  it("hole in a def name is an identifier hole", () => {
    expect(firstHole(`def #name(): number {\n  return 1\n}\n`).sort).toBe("identifier");
  });

  it("hole in a node name is an identifier hole", () => {
    expect(firstHole(`node #n() {\n  return 1\n}\n`).sort).toBe("identifier");
  });

  it("hole in an import specifier is an identifier hole", () => {
    expect(firstHole(`import { #tool } from "std::fs"\n\nnode main() {\n  return 1\n}\n`).sort).toBe(
      "identifier",
    );
  });

  it("hole at top level is a decl hole", () => {
    expect(firstHole(`#helpers\n\nnode main() {\n  return 1\n}\n`).sort).toBe("decl");
  });
});

describe("splices and quoted names", () => {
  it("parses a splice", () => {
    const r = holeParser("#...items");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ name: "items", splice: true });
  });

  it("parses a quoted name", () => {
    const r = holeParser(`#"hi-there"`);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ name: "hi-there", splice: false });
  });

  it("parses a quoted splice", () => {
    const r = holeParser(`#..."tool-imports"`);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ name: "tool-imports", splice: true });
  });

  it("rejects a quoted name containing a space", () => {
    expect(holeParser(`#"hi there"`).success).toBe(false);
  });

  it("rejects an empty quoted name", () => {
    expect(holeParser(`#""`).success).toBe(false);
  });

  it("rejects a splice with no name", () => {
    expect(holeParser("#...").success).toBe(false);
  });

  it("rejects a splice in expression position", () => {
    expect(parses(`node main() {\n  const x = #...items\n}\n`)).toBe(false);
  });

  it("rejects a splice in a def-name position", () => {
    expect(parses(`def #...name(): number {\n  return 1\n}\n`)).toBe(false);
  });

  it("rejects a splice in an import specifier", () => {
    expect(parses(`import { #...tools } from "std::fs"\n\nnode main() {\n  return 1\n}\n`)).toBe(
      false,
    );
  });

  it("allows a splice in statement position", () => {
    expect(parses(`node main() {\n  #...steps\n}\n`)).toBe(true);
  });

  it("allows a splice in an argument list", () => {
    expect(parses(`node main() {\n  f(#...args)\n}\n`)).toBe(true);
  });
});

// The tripwire for hygiene's walker dependency (see freeNamesOf in
// lib/runtime/template/hygiene.ts): every expression position a hole can
// occupy must be REACHED by walkNodes' descent, or free-name analysis
// under-reports and capture avoidance fails open. Each entry pins one
// position; add one when a node kind gains an expression child.
describe("hole positions are reachable by the walker", () => {
  const positions: [string, string][] = [
    ["assignment value", `node main() {\n  const x = #h\n}\n`],
    ["binop operand", `node main() {\n  const x = #h + 1\n}\n`],
    ["if condition", `node main() {\n  if (#h) {\n    return 1\n  }\n}\n`],
    ["while condition", `node main() {\n  while (#h) {\n    return 1\n  }\n}\n`],
    ["call argument", `node main() {\n  f(#h)\n}\n`],
    ["named argument", `node main() {\n  f(count: #h)\n}\n`],
    ["guard head argument", `node main() {\n  const r = guard(time: #h) {\n    return 1\n  }\n}\n`],
    ["return value", `node main() {\n  return #h\n}\n`],
    ["array element", `node main() {\n  const x = [#h]\n}\n`],
    ["object value", `node main() {\n  const x = { k: #h }\n}\n`],
    ["string interpolation", `node main() {\n  const x = "v: \${#h}"\n}\n`],
    ["for-loop iterable", `node main() {\n  for (item in #h) {\n    print(item)\n  }\n}\n`],
    ["match scrutinee", `node main() {\n  const x = match (#h) {\n    1 => "a"\n    _ => "b"\n  }\n}\n`],
    ["try expression", `node main() {\n  const x = try f(#h)\n}\n`],
    // typeTestExpression needs no entry: it is a lowering artifact
    // (lib/types/pattern.ts) and templates parse with lower: false.
    ["is-expression operand", `node main() {\n  const x: boolean = #h is string\n}\n`],
  ];

  for (const [label, source] of positions) {
    it(`finds a hole in ${label}`, () => {
      expect(firstHole(source).name).toBe("h");
    });
  }
});

describe("holes in operand positions", () => {
  it("parses on the left of a binary operator", () => {
    expect(parses(`node main() {\n  const x = #a + 1\n}\n`)).toBe(true);
  });

  it("parses inside a condition", () => {
    expect(parses(`node main() {\n  if (#cond) {\n    return 1\n  }\n}\n`)).toBe(true);
  });

  it("parses as a call argument", () => {
    expect(parses(`node main() {\n  f(#arg)\n}\n`)).toBe(true);
  });

  it("parses as a named-argument value", () => {
    // guard(maxTime: #minutes) — the guard-template composition depends on this.
    expect(
      parses(`node main() {\n  guard(maxTime: #minutes) {\n    print(1)\n  }\n}\n`),
    ).toBe(true);
  });
});
