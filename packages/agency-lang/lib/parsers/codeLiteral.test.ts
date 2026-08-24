import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { walkNodesArray } from "../utils/node.js";
import { generateAgency } from "../backends/agencyGenerator.js";
import type { AgencyNode, CodeLiteral } from "../types.js";

function parseOk(source: string, applyTemplate = false) {
  const result = parseAgency(source, {}, applyTemplate, false);
  if (!result.success) throw new Error(result.message);
  return result.result;
}

/** The first codeLiteral node in a template-mode parse of `source`. */
function firstLiteral(source: string): CodeLiteral {
  const found = walkNodesArray(parseOk(source).nodes)
    .map((visit) => visit.node)
    .find((node) => node.type === "codeLiteral");
  if (!found) throw new Error(`no code literal found in: ${source}`);
  return found as CodeLiteral;
}

/** Concatenated text segments of a string node (throws on non-strings). */
function stringTextOf(node: AgencyNode): string {
  const literal = node as { type: string; segments?: { type: string; value?: string }[] };
  if (!Array.isArray(literal.segments)) throw new Error(`not a string node: ${literal.type}`);
  return literal.segments
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.value ?? "")
    .join("");
}

describe("code literals: single-line bodies", () => {
  // The program grammar ends in `eof` and does not skip leading spaces,
  // and the body of `[| ... |]` on one line begins with one. A leading
  // newline was fine, so multi-line bodies worked and single-line ones
  // did not, which made the difference look like a rule about
  // definitions rather than about whitespace.
  it("parses a one-line def, which needs the program grammar", () => {
    const lit = firstLiteral(
      `def f(): Code {\n  return [| def greet(): string { return "hi" } |]\n}\n`,
    );
    expect(lit.kind).toBe("program");
    expect(lit.nodes.map((node) => node.type)).toContain("function");
  });

  it("parses a one-line def with an empty body", () => {
    const lit = firstLiteral(`def f(): Code {\n  return [| def greet(): string { } |]\n}\n`);
    expect(lit.kind).toBe("program");
  });

  it("parses a one-line node", () => {
    const lit = firstLiteral(
      `def f(): Code {\n  return [| node main(): number { return 1 } |]\n}\n`,
    );
    expect(lit.nodes.map((node) => node.type)).toContain("graphNode");
  });

  it("agrees with the same text written across lines", () => {
    const oneLine = firstLiteral(
      `def f(): Code {\n  return [| def greet(): string { return "hi" } |]\n}\n`,
    );
    const multiLine = firstLiteral(
      `def f(): Code {\n  return [|\n    def greet(): string {\n      return "hi"\n    }\n  |]\n}\n`,
    );
    expect(oneLine.kind).toBe(multiLine.kind);
    expect(oneLine.nodes.map((node) => node.type)).toEqual(
      multiLine.nodes.map((node) => node.type),
    );
  });

  it("keeps node positions in enclosing-file coordinates", () => {
    // Trimming the body before the program attempt moves what the parser
    // sees, so the base position moves with it. Splices stamp loc.origin
    // on grafted nodes and error attribution rides on these numbers, so a
    // silent shift here would misplace every error inside generated code.
    //
    // Both point at the `d` of `def` in the enclosing file. Line and
    // column are 0-indexed (docs/dev/compiler/locations.md).
    const multiLine = firstLiteral(
      `def f(): Code {\n  return [|\n    def greet(): string {\n      return "hi"\n    }\n  |]\n}\n`,
    );
    expect(multiLine.nodes[0].loc).toMatchObject({ line: 2, col: 4 });

    const oneLine = firstLiteral(
      `def f(): Code {\n  return [| def greet(): string { return "hi" } |]\n}\n`,
    );
    expect(oneLine.nodes[0].loc).toMatchObject({ line: 1, col: 12 });
  });

  it("does not emit a leading newline node for a multi-line body", () => {
    // The one behaviour that did change. The program attempt used to see
    // the untrimmed body, so `[|\n  def ... |]` produced a `newLine` node
    // ahead of the definition. The expr and statements attempts always
    // trimmed; this makes the third agree with them.
    const multiLine = firstLiteral(
      `def f(): Code {\n  return [|\n    def greet(): string {\n      return "hi"\n    }\n  |]\n}\n`,
    );
    expect(multiLine.nodes.map((node) => node.type)).toEqual(["function"]);
  });
});

describe("code literals: kind inference", () => {
  it("a lone expression infers expr", () => {
    const lit = firstLiteral(`node main() {\n  const t = [| 1 + 2 |]\n}\n`);
    expect(lit.kind).toBe("expr");
    expect(lit.nodes).toHaveLength(1);
    expect(lit.nodes[0].type).toBe("binOpExpression");
  });

  it("f(1) infers expr (the known ambiguity, closed by the fill relaxation)", () => {
    const lit = firstLiteral(`node main() {\n  const t = [| f(1) |]\n}\n`);
    expect(lit.kind).toBe("expr");
    expect(lit.nodes[0].type).toBe("functionCall");
  });

  it("two statements infer statements", () => {
    const lit = firstLiteral(
      `node main() {\n  const t = [|\n    const a = 1\n    print(a)\n  |]\n}\n`,
    );
    expect(lit.kind).toBe("statements");
    expect(lit.nodes.filter((n) => n.type !== "newLine")).toHaveLength(2);
  });

  it("a def infers program", () => {
    const lit = firstLiteral(
      `node main() {\n  const t = [|\n    def g(): number {\n      return 1\n    }\n  |]\n}\n`,
    );
    expect(lit.kind).toBe("program");
    expect(lit.nodes.some((n) => n.type === "function")).toBe(true);
  });

  it("holes parse inside bodies by position", () => {
    const lit = firstLiteral(`node main() {\n  const t = [|\n    const x: number = #n\n  |]\n}\n`);
    const hole = walkNodesArray(lit.nodes)
      .map((visit) => visit.node)
      .find((node) => node.type === "hole") as { sort?: string; name?: string };
    expect(hole?.name).toBe("n");
    expect(hole?.sort).toBe("expr");
  });

  it("empty body is an empty statements fragment (decided, matching parseStatements)", () => {
    // Spec open question 2, DECIDED by the consistency rule: bodyParser
    // accepts empty input with zero statements, so parseStatements("")
    // succeeds — and the literal must agree with the runtime parser or
    // the two disagree about the same text. An empty statements fragment
    // is also USEFUL: it fills a statements hole with nothing, the
    // "generate no extra steps" case. If bodyParser ever changes, this
    // test forces the literal ruling to be revisited deliberately.
    const lit = firstLiteral(`node main() {\n  const t = [| |]\n}\n`);
    expect(lit.kind).toBe("statements");
    expect(lit.nodes).toHaveLength(0);
  });
});

describe("code literals: baseAtom ordering is untouched", () => {
  it("array literals and comprehensions still parse", () => {
    expect(parseAgency(`node main() {\n  const a = [1, 2]\n}\n`, {}, false, false).success).toBe(
      true,
    );
    expect(
      parseAgency(`node main() {\n  const b = [n * 2 for n in xs]\n}\n`, {}, false, false).success,
    ).toBe(true);
    expect(
      parseAgency(`node main() {\n  const c = [1, 2].join(",")\n}\n`, {}, false, false).success,
    ).toBe(true);
  });
});

// End-scan tests assert BODY CONTENT structurally, never just `.success`:
// a scan that terminates early can coincidentally still parse, and a bare
// success check would be a false green on the riskiest code path.
describe("code literals: the end-scan", () => {
  it("|] inside a body string is inert, content intact", () => {
    const lit = firstLiteral(`node main() {\n  const t = [| return "Pick: [x|y|]" |]\n}\n`);
    const ret = lit.nodes[0] as { type: string; value?: AgencyNode };
    expect(ret.type).toBe("returnStatement");
    expect(stringTextOf(ret.value as AgencyNode)).toBe("Pick: [x|y|]");
  });

  it("|] inside a body comment is inert", () => {
    const lit = firstLiteral(
      `node main() {\n  const t = [|\n    // options render as [a|b|]\n    print(1)\n  |]\n}\n`,
    );
    expect(
      lit.nodes.some(
        (n) =>
          n.type === "functionCall" && (n as { functionName?: unknown }).functionName === "print",
      ),
    ).toBe(true);
  });

  it("|] inside an interpolation's nested string is inert, content intact", () => {
    const lit = firstLiteral(`node main() {\n  const t = [| return "\${f("has |] here")}" |]\n}\n`);
    const printed = generateAgency({ type: "agencyProgram", nodes: lit.nodes });
    expect(printed).toContain("has |] here");
  });

  it("|] in interpolation code position is inert (pinned decision)", () => {
    // The |] belongs to the GENERATED program's string; the string parser
    // consumes the whole interpolation, so the literal does not end there.
    const lit = firstLiteral(`node main() {\n  const t = [| return "\${join(xs, "|]")}" |]\n}\n`);
    const printed = generateAgency({ type: "agencyProgram", nodes: lit.nodes });
    expect(printed).toContain(`join(xs, "|]")`);
  });

  it("blank lines inside a body survive", () => {
    const lit = firstLiteral(
      `node main() {\n  const t = [|\n    print(1)\n\n    print(2)\n  |]\n}\n`,
    );
    expect(lit.nodes.filter((n) => n.type === "functionCall")).toHaveLength(2);
  });

  it("nested [| is a directive error", () => {
    const result = parseAgency(
      `node main() {\n  const t = [| const x = [| 1 |] |]\n}\n`,
      {},
      false,
      false,
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.message).toMatch(/build the inner piece/);
  });

  it("unclosed literal reports the missing |]", () => {
    const result = parseAgency(`node main() {\n  const t = [| print(1)\n}\n`, {}, false, false);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.message).toMatch(/\|\]/);
  });
});

// Location mapping: expected lines computed BY HAND from intent, written
// before running the code. If the observed value disagrees, that is a bug
// to fix, not a number to copy — this pair exists to catch the
// stripped-prefix and offset-additivity mistakes specifically.
describe("code literals: location mapping", () => {
  // File (0-indexed): line 0 `node main() {`, line 1 opens the literal,
  // the body error sits on file line 2. The body's own error message is
  // 1-indexed ("Line 2" for body line index 1); the mapping adds the
  // literal's user-coordinate start line (1), so the surfaced message
  // says Line 3.
  const source = `node main() {\n  const t = [|\n    const = broken\n  |]\n}\n`;

  it("a body parse error maps to the enclosing file's line (no prelude offset)", () => {
    const result = parseAgency(source, {}, false, false);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.message).toMatch(/code literal body: Line 3, col/);
  });

  it("mapping is additive under the prelude template offset", () => {
    // Same source parsed WITH the prelude template: user-coordinate lines
    // must be IDENTICAL (the prelude offset is subtracted globally; the
    // literal shift must not double- or under-count it).
    const result = parseAgency(source, {}, true, false);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.message).toMatch(/code literal body: Line 3, col/);
  });

  it("a literal's own loc is the enclosing file's line", () => {
    const lit = firstLiteral(`node main() {\n  const t = [| 1 |]\n}\n`);
    expect(lit.loc?.line).toBe(1);
  });

  it("body node locs shift into enclosing coordinates, stripped prefix included", () => {
    // Literal opens on file line 1; the print sits on file line 2. The
    // body's leading "\n    " is stripped before the statements parse, so
    // an unshifted or prefix-blind mapping would report line 0 or 1.
    const lit = firstLiteral(`node main() {\n  const t = [|\n    print(1)\n  |]\n}\n`);
    const call = lit.nodes.find((n) => n.type === "functionCall") as { loc?: { line?: number } };
    expect(call.loc?.line).toBe(2);
  });
});

// Review round: regex inertness, sentinel symmetry, squiggle position.
describe("code literals: review-round pins", () => {
  it("re/[|]/ in a body is a regex, not nesting", () => {
    const lit = firstLiteral(`node main() {\n  const t = [| const p = re/[|]/ |]\n}\n`);
    const regex = walkNodesArray(lit.nodes)
      .map((visit) => visit.node)
      .find((node) => node.type === "regex") as { pattern?: string };
    expect(regex?.pattern).toBe("[|]");
  });

  it("re/a|]b/ in a body does not end the literal early", () => {
    const lit = firstLiteral(`node main() {\n  const t = [| const p = re/a|]b/ |]\n}\n`);
    const regex = walkNodesArray(lit.nodes)
      .map((visit) => visit.node)
      .find((node) => node.type === "regex") as { pattern?: string };
    expect(regex?.pattern).toBe("a|]b");
  });

  it("a leading blank line does not flip an expr body to statements", () => {
    const lit = firstLiteral(`node main() {\n  const t = [|\n\n    1 + 2\n  |]\n}\n`);
    expect(lit.kind).toBe("expr");
  });

  it("a malformed body's error position lands inside the literal", () => {
    // The message comes from the committed failure; the structured
    // position must come from the SAME failure, not the shallower
    // rightmost record, or the LSP squiggle lands away from the message.
    const source = `node main() {\n  const t = [|\n    const = broken\n  |]\n}\n`;
    const result = parseAgency(source, {}, false, false);
    expect(result.success).toBe(false);
    if (result.success) return;
    const errorData = (result as { errorData?: { line: number } }).errorData;
    expect(errorData).toBeDefined();
    // The literal spans file lines 1-3 (0-indexed); the reported line
    // must be inside it, not at the assignment or file start.
    expect(errorData!.line).toBeGreaterThanOrEqual(1);
    expect(errorData!.line).toBeLessThanOrEqual(3);
  });
});

describe("declarations in a literal infer program", () => {
  // `expects` lists node types the literal must hold. Order is not
  // asserted — a leading comment is kept as a node of its own, so the
  // declaration is not always first.
  const cases: { body: string; expects: string[]; label: string }[] = [
    { label: "un-annotated node", body: "node main() {\n  print(1)\n}", expects: ["graphNode"] },
    { label: "un-annotated def", body: "def foo() {\n  return 1\n}", expects: ["function"] },
    {
      label: "node with parameters",
      body: "node m(x: number) {\n  print(x)\n}",
      expects: ["graphNode"],
    },
    {
      label: "two declarations",
      body: "node a() {\n  print(1)\n}\n\nnode b() {\n  print(2)\n}",
      expects: ["graphNode"],
    },
    {
      label: "comment first",
      body: "// hi\nnode main() {\n  print(1)\n}",
      expects: ["comment", "graphNode"],
    },
    {
      label: "statement then declaration",
      body: "print(1)\nnode main() {\n  print(2)\n}",
      expects: ["functionCall", "graphNode"],
    },
  ];

  for (const { label, body, expects } of cases) {
    it(`infers program for a ${label}`, () => {
      const lit = firstLiteral(`node host() {\n  const t = [|\n${body}\n  |]\n}\n`);
      expect(lit.kind, label).toBe("program");
      // The kind alone is not enough: it was already wrong for a reason
      // only the node types reveal. Under the bug the declaration became a
      // `variableName` plus a `functionCall`, so both halves of this
      // matter — the declaration is present, and no stray name is.
      const types = lit.nodes.map((node) => node.type);
      for (const expected of expects) {
        expect(types, `${label}: ${expected}`).toContain(expected);
      }
      expect(types, label).not.toContain("variableName");
    });
  }

  it("still infers program for an annotated node", () => {
    const lit = firstLiteral(
      `node host() {\n  const t = [|\n    node main(): string {\n      return "x"\n    }\n  |]\n}\n`,
    );
    expect(lit.kind).toBe("program");
    expect(lit.nodes[0].type).toBe("graphNode");
  });

  it("still infers program for an annotated def", () => {
    // `def` takes the other branch of the probe's `or`, so it needs its
    // own annotated case, not just the un-annotated one above.
    const lit = firstLiteral(
      `node host() {\n  const t = [|\n    def foo(): number {\n      return 1\n    }\n  |]\n}\n`,
    );
    expect(lit.kind).toBe("program");
    expect(lit.nodes[0].type).toBe("function");
  });

  it("reports a broken declaration instead of silently reading two statements", () => {
    // Before the fix this parsed as statements and produced junk. Now the
    // statements attempt declines, the program attempt runs, and its own
    // declaration parser reports the real problem — the unclosed parameter
    // list. Asserting the message matters as much as asserting the failure:
    // a future change that keeps the failure but degrades the message to a
    // generic one would still pass a success-only check while telling the
    // user nothing.
    const source = `node host() {\n  const t = [|\n    node main( {\n      print(1)\n    }\n  |]\n}\n`;
    const result = parseAgency(source, {}, true, false);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain("parameter list");
  });
});

describe("bodies whose kind must not change", () => {
  // Regression guards. Each begins with a word that a keyword-routing fix
  // would have misread, and `type` / `effect` are legal in bodies so their
  // statements answer is the correct one.
  const cases: { body: string; kind: string }[] = [
    { body: "node", kind: "expr" },
    { body: "node.run()", kind: "expr" },
    { body: "node + 1", kind: "expr" },
    { body: "const x = 1", kind: "statements" },
    { body: "print(1)", kind: "expr" },
    { body: "type P = { n: number }", kind: "statements" },
    { body: "effect Foo", kind: "statements" },
  ];

  for (const { body, kind } of cases) {
    it(`keeps \`${body}\` as ${kind}`, () => {
      const lit = firstLiteral(
        `node host() {\n  const node = 1\n  const t = [| ${body} |]\n  print("x")\n}\n`,
      );
      expect(lit.kind, body).toBe(kind);
    });
  }
});

describe("a throwing attempt does not abandon the remaining attempts", () => {
  // `static const` is rejected inside a function body by a parser that
  // reports through tarsec's parseError, which THROWS. A literal body may
  // legitimately be a whole program, where `static const` is correct.
  it("parses a static const literal as a program", () => {
    const lit = firstLiteral(
      `node host() {\n  const t = [|\n    static const x = 1\n  |]\n  print("y")\n}\n`,
    );
    expect(lit.kind).toBe("program");
    expect(lit.nodes.map((node) => node.type)).toContain("assignment");
  });

  it("parses a static const written after another statement", () => {
    const lit = firstLiteral(
      `node host() {\n  const t = [|\n    const a = 1\n    static const x = 2\n  |]\n  print("y")\n}\n`,
    );
    expect(lit.kind).toBe("program");
    expect(lit.nodes.filter((node) => node.type === "assignment").length).toBe(2);
  });
});
