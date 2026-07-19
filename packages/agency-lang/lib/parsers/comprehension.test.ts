import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

/** Parses with `lower: false` so the raw comprehension node survives.
 *  The prelude import occupies nodes[0], so the node definition is found
 *  by type. The runtime tag is "graphNode" - "graphNodeDefinition" is
 *  only the TypeScript type name and matches nothing at runtime. */
function parseExpr(src: string) {
  const result = parseAgency(
    `node main() {\n  const x = ${src}\n}`,
    {},
    true,
    false,
  );
  if (!result.success) {
    throw new Error("parse failed");
  }
  const nodes = result.result.nodes as any[];
  const main = nodes.find((n) => n.type === "graphNode");
  if (!main) {
    throw new Error("no node definition found");
  }
  return main.body[0].value;
}

function parseFails(src: string): boolean {
  const result = parseAgency(
    `node main() {\n  const x = ${src}\n}`,
    {},
    true,
    false,
  );
  return !result.success;
}

describe("comprehensionParser", () => {
  it("parses a plain comprehension", () => {
    const node = parseExpr("[f(x) for x in xs]");
    expect(node.type).toBe("comprehension");
    expect(node.itemVar).toBe("x");
    expect(node.mode).toBe("seq");
    expect(node.shared).toBe(false);
    expect(node.condition).toBeUndefined();
  });

  it("parses a filter clause", () => {
    const node = parseExpr("[f(x) for x in xs if p(x)]");
    expect(node.condition).toBeDefined();
    expect(node.condition.functionName).toBe("p");
  });

  it("parses a two-binder comprehension", () => {
    const node = parseExpr("[f(x, i) for x, i in xs]");
    expect(node.itemVar).toBe("x");
    expect(node.indexVar).toBe("i");
  });

  it("parses an object destructuring binder", () => {
    const node = parseExpr("[name for {name, age} in people]");
    expect(node.itemVar.type).toBe("objectPattern");
  });

  it("parses an array destructuring binder", () => {
    const node = parseExpr("[a for [a, b] in pairs]");
    expect(node.itemVar.type).toBe("arrayPattern");
  });

  it("parses the fork form", () => {
    const node = parseExpr("fork [f(x) for x in xs]");
    expect(node.type).toBe("comprehension");
    expect(node.mode).toBe("fork");
    expect(node.shared).toBe(false);
  });

  it("parses the fork form with a filter", () => {
    const node = parseExpr("fork [f(x) for x in xs if p(x)]");
    expect(node.mode).toBe("fork");
    expect(node.shared).toBe(false);
    expect(node.condition).toBeDefined();
  });

  it("parses the forkShared form", () => {
    // also the ordering pin: if the or() tried str("fork") before
    // str("forkShared"), fork would match, die on the S where required
    // whitespace should be, and this test would fail
    const node = parseExpr("forkShared [f(x) for x in xs]");
    expect(node.type).toBe("comprehension");
    expect(node.mode).toBe("fork");
    expect(node.shared).toBe(true);
  });

  it("parses the race form", () => {
    const node = parseExpr("race [f(x) for x in xs]");
    expect(node.mode).toBe("race");
    expect(node.shared).toBe(false);
  });

  it("parses the raceShared form", () => {
    const node = parseExpr("raceShared [f(x) for x in xs]");
    expect(node.mode).toBe("race");
    expect(node.shared).toBe(true);
  });

  it("composes a shared prefix with a filter and two binders", () => {
    const node = parseExpr("forkShared [f(x, i) for x, i in xs if p(x)]");
    expect(node.mode).toBe("fork");
    expect(node.shared).toBe(true);
    expect(node.indexVar).toBe("i");
    expect(node.condition).toBeDefined();
  });

  it("parses a multi-line comprehension behind a new prefix", () => {
    // tarsec spaces cross newlines; the merged suite pins this at every
    // keyword boundary, and the prefix is a fourth boundary with the
    // same exposure
    const node = parseExpr("forkShared [f(x)\n    for x in xs]");
    expect(node.mode).toBe("fork");
    expect(node.shared).toBe(true);
  });

  // Not a prefix without required whitespace after the keyword. Probed
  // against the pre-change grammar as failing; the new grammar reaches
  // the same conclusion by a different path (forkShared matches then
  // dies on the space, fork matches then dies on the S) - this test IS
  // the re-verification the plan calls for.
  it("does not treat forkSharedx as a prefix", () => {
    expect(parseFails("forkSharedx [x for x in xs]")).toBe(true);
  });

  // forkShared is not reserved. No-space indexing parses as value
  // access (the comprehension parser needs whitespace after the
  // keyword, so it never engages); WITH a space it fails to parse -
  // matching `somearr [0]`, because spaced indexing is not legal
  // Agency for ANY identifier (probed).
  it("still parses forkShared[0] as indexing", () => {
    const node = parseExpr("forkShared[0]");
    expect(node.type).toBe("valueAccess");
  });

  it("rejects forkShared [0] the same as any spaced indexing", () => {
    expect(parseFails("forkShared [0]")).toBe(true);
    expect(parseFails("somearr [0]")).toBe(true);
  });

  // race was already a callable (race(items, shared: true) as x { } is
  // documented in the concurrency guide) and this plan promotes the
  // word to a prefix keyword. Pin that existing call uses survive: the
  // prefix rule needs whitespace-then-bracket, so a paren falls through.
  it("still parses race(xs) as x {} as a function call", () => {
    const node = parseExpr("race(xs) as x { return x }");
    expect(node.type).toBe("functionCall");
    expect(node.functionName).toBe("race");
    expect(node.block).toBeDefined();
  });

  it("still rejects race (xs) like any spaced call", () => {
    // spaced calls are not legal Agency for any identifier (probed
    // pre-change with the same input); the prefix must not change that
    expect(parseFails("race (xs) as x { return x }")).toBe(true);
  });

  // Bracket-nesting cases: the inner `]` is a plausible place for the
  // comprehension parser to terminate early.
  it("parses an array literal as the iterable", () => {
    const node = parseExpr("[f(x) for x in [1, 2, 3]]");
    expect(node.type).toBe("comprehension");
    expect(node.iterable.type).toBe("agencyArray");
  });

  it("parses a nested comprehension", () => {
    const node = parseExpr("[[y for y in row] for row in rows]");
    expect(node.type).toBe("comprehension");
    expect(node.expression.type).toBe("comprehension");
  });

  // Adversarial: the binder is found by scanning for `for`, so a string
  // containing the word is the obvious way to confuse it.
  it("parses a body string containing the word for", () => {
    const node = parseExpr('["waiting for ${x}" for x in xs]');
    expect(node.type).toBe("comprehension");
    expect(node.itemVar).toBe("x");
  });

  // The ambiguity guard: `[` opens both an array literal and a
  // comprehension. Getting this wrong breaks every array in the language.
  it("still parses an ordinary array literal", () => {
    const node = parseExpr("[1, 2, 3]");
    expect(node.type).toBe("agencyArray");
    expect(node.items).toHaveLength(3);
  });

  it("still parses an empty array literal", () => {
    expect(parseExpr("[]").type).toBe("agencyArray");
  });

  it("still parses an array whose first item is a call", () => {
    expect(parseExpr("[f(x), g(y)]").type).toBe("agencyArray");
  });

  it("still parses an array containing the identifier format", () => {
    // guards against matching the bare prefix `for` inside a longer name
    expect(parseExpr("[format, other]").type).toBe("agencyArray");
  });

  // Half-typed comprehensions are now a thing users and agents will
  // produce constantly. They do NOT error: the array parser accepts
  // whitespace-separated items and `in` is a binary operator, so these
  // have always parsed as arrays of variable names (probed - this is
  // pre-existing behavior, not something this feature introduced). Pin
  // that they at least never become half-baked comprehension nodes, so
  // a later improvement shows up as a diff. A real diagnostic at the
  // comprehension is tracked as issue #602.
  it.each([["[x for x in]"], ["[for x in xs]"], ["[x for in xs]"]])(
    "parses the malformed comprehension %s as an array, not a comprehension",
    (src) => {
      expect(parseFails(src)).toBe(false);
      expect(parseExpr(src).type).toBe("agencyArray");
    },
  );

  // tarsec's `spaces` matches newlines too, so a comprehension broken
  // across lines parses fine. Pinned deliberately: the guide can promise
  // multi-line works, and a regression here (e.g. swapping in a
  // same-line-only whitespace parser) is visible as a diff.
  it("parses a multi-line comprehension", () => {
    const node = parseExpr("[f(x)\n    for x in xs]");
    expect(node.type).toBe("comprehension");
    expect(node.itemVar).toBe("x");
  });

  it("parses line breaks before in and if, not just before for", () => {
    // the before-keyword whitespace must cross newlines at EVERY
    // boundary - the naive version only worked before `for`, and only
    // because a call body happens to eat its own trailing newline
    const node = parseExpr("[f(x)\n    for x\n    in xs\n    if p(x)]");
    expect(node.type).toBe("comprehension");
    expect(node.condition).toBeDefined();
  });
});
