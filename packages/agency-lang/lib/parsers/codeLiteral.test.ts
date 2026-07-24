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
        (n) => n.type === "functionCall" && (n as { functionName?: unknown }).functionName === "print",
      ),
    ).toBe(true);
  });

  it("|] inside an interpolation's nested string is inert, content intact", () => {
    const lit = firstLiteral(
      `node main() {\n  const t = [| return "\${f("has |] here")}" |]\n}\n`,
    );
    const printed = generateAgency({ type: "agencyProgram", nodes: lit.nodes });
    expect(printed).toContain("has |] here");
  });

  it("|] in interpolation code position is inert (pinned decision)", () => {
    // The |] belongs to the GENERATED program's string; the string parser
    // consumes the whole interpolation, so the literal does not end there.
    const lit = firstLiteral(
      `node main() {\n  const t = [| return "\${join(xs, "|]")}" |]\n}\n`,
    );
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
