import { describe, it, expect } from "vitest";
import { isLegalAtTopLevel } from "./topLevel.js";
import { parseAgency } from "../parser.js";
import { TOP_LEVEL_DECLARATION_TYPES } from "../backends/typescriptBuilder/nameClassifier.js";
import type { AgencyNode } from "../types.js";

/** The first non-trivia node of a program parsed from `source`. */
function firstNode(source: string): AgencyNode {
  const result = parseAgency(source, {}, false);
  if (!result.success) throw new Error(`${source}: ${result.message}`);
  // Skip trivia only. NOT importStatement — one allowed case IS an import.
  const node = result.result.nodes.find(
    (n) => n.type !== "newLine" && n.type !== "comment",
  );
  if (!node) throw new Error(`no node in: ${source}`);
  return node;
}

describe("isLegalAtTopLevel: allowed", () => {
  // Top-level code is initialization. It may ESTABLISH something.
  const allowed: string[] = [
    "node main() { print(1) }",
    "def helper(): number { return 1 }",
    "type Person = { name: string }",
    "const x = 1",
    "let y = 2",
    "static const z = 3",
    "x = 1",
    "print(1)",
    "foo.bar",
    "static print(1)",
    "debugger", // parses as a variableName, not a debuggerStatement
    "someName",
    "1 + 2",
    "true",
    "null",
    // Supported deliberately: issue #229 made this work at module scope
    // rather than refusing it.
    "foo() with approve",
  ];

  for (const source of allowed) {
    it(`allows: ${source}`, () => {
      expect(isLegalAtTopLevel(firstNode(source)), source).toBe(true);
    });
  }
});

describe("isLegalAtTopLevel: refused", () => {
  // It may not CONTROL anything: the init phases have no step machinery.
  const refused: string[] = [
    "if (true) { print(1) }",
    "while (false) { print(1) }",
    "for (x in [1, 2]) { print(x) }",
    "match(1) { 1 => print(1) }",
    "thread { print(1) }",
    "handle {\n  print(1)\n} with (e) {\n  return approve()\n}",
    "return 1",
    'interrupt("x")',
    'static interrupt("x")',
    // The parenthesized form, which is a real debuggerStatement and
    // crashes today — the opposite side of the rule from bare `debugger`.
    'debugger("x")',
  ];

  for (const source of refused) {
    it(`refuses: ${source.split("\n")[0]}`, () => {
      expect(isLegalAtTopLevel(firstNode(source)), source).toBe(false);
    });
  }
});

describe("isLegalAtTopLevel: goto is not reachable at the top level", () => {
  it("parses as two bare names, so it stays legal", () => {
    // `goto other` at file scope is NOT a gotoStatement — the grammar
    // yields `variableName("goto")` and `variableName("other")`. So the
    // gotoStatement row is unobservable here, and this spelling keeps
    // compiling. Pinned because it looks like a refusal and is not one.
    const result = parseAgency("goto other\n\nnode main() { print(1) }\n", {}, false);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const types = result.result.nodes.map((n) => n.type);
    expect(types.filter((t) => t === "variableName")).toHaveLength(2);
    expect(types).not.toContain("gotoStatement");
  });
});

describe("isLegalAtTopLevel: body-only forms", () => {
  // These cannot be parsed at the top level, so no whole-file test can
  // reach them — but a statements FRAGMENT parses body grammar, so a
  // top-level splice takes them straight to the per-node check. Pull them
  // out of a body parse to exercise the table rows that path depends on.
  function firstBodyNode(body: string): AgencyNode {
    const node = firstNode(`node m() {\n${body}\n}\n`) as { body?: AgencyNode[] };
    const inner = node.body?.[0];
    if (!inner) throw new Error(`no body node in: ${body}`);
    return inner;
  }

  const refused: [string, string][] = [
    ["guard", "  guard(maxTime: 100) {\n    print(1)\n  }"],
    ["finalize", "  finalize {\n    print(1)\n  }"],
    ["if", "  if (true) {\n    print(1)\n  }"],
  ];

  for (const [label, body] of refused) {
    it(`refuses a ${label} block`, () => {
      expect(isLegalAtTopLevel(firstBodyNode(body)), label).toBe(false);
    });
  }
});

describe("isLegalAtTopLevel: static wraps its inner statement", () => {
  it("judges the statement inside, not the `static`", () => {
    expect(isLegalAtTopLevel(firstNode("static print(1)"))).toBe(true);
    expect(isLegalAtTopLevel(firstNode('static interrupt("x")'))).toBe(false);
  });
});

describe("placement can never route an illegal node", () => {
  // Three things describe the top level after this change: the grammar
  // (permissive), the placement set (where a node is emitted), and this
  // predicate (whether it may be there). This closes the triangle.
  it("every top-level declaration type is legal at the top level", () => {
    // Reads the REAL set, never a copy — a copy is what this test exists
    // to prevent.
    for (const type of TOP_LEVEL_DECLARATION_TYPES) {
      expect(isLegalAtTopLevel({ type } as AgencyNode), type).toBe(true);
    }
  });

  it("a static assignment is legal too", () => {
    // The placement set's other half: `isTopLevelDeclaration` special-cases
    // a static-scoped assignment.
    expect(isLegalAtTopLevel({ type: "assignment" } as AgencyNode)).toBe(true);
  });
});
