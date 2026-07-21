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

/** True when the source fails to parse AND the failure message matches -
 *  the targeted-diagnostic contract from #602. */
function parseFailsWith(src: string, re: RegExp): boolean {
  const result = parseAgency(
    `node main() {\n  const x = ${src}\n}`,
    {},
    true,
    false,
  );
  if (result.success) {
    return false;
  }
  return re.test((result as { message?: string }).message ?? "");
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

  // Half-typed comprehensions now ERROR at the comprehension (#602).
  // Two mechanisms combine: literal items require commas between them
  // again (the 2026-07-04 comma-optional regression is fixed, so these
  // can no longer fall back to whitespace-separated arrays of variable
  // names), and the comprehension parser COMMITS once `[ expr for ` has
  // matched, turning later failures into targeted messages instead of
  // a silent backtrack.
  it("reports a missing iterable", () => {
    expect(parseFailsWith("[x for x in]", /iterable/)).toBe(true);
  });

  it("reports a missing binder even with no space before the bracket", () => {
    // an editor auto-closing the bracket turns a half-typed `[x for`
    // into `[x for]` - the commit must not be gated on the user having
    // typed a trailing space
    expect(parseFailsWith("[x for]", /binder/)).toBe(true);
    expect(parseFailsWith("[x for ]", /binder/)).toBe(true);
  });

  // in/if inside the commit points are word-bounded, so a fused token
  // reports the missing KEYWORD rather than blaming the next clause
  it("does not let insomething match as in", () => {
    expect(
      parseFailsWith("[x for x insomething]", /expected `in`/),
    ).toBe(true);
  });

  it("does not let iffy match as a filter if", () => {
    // iffy is not a filter keyword; with the boundary the optional
    // filter backtracks and the close-bracket commit reports instead
    expect(parseFailsWith("[x for x in xs iffy]", /close/)).toBe(true);
  });

  it("still treats forever as an identifier, not a for prefix", () => {
    // the word boundary after `for` replaces the old required-space
    // rule; a longer identifier must still fail BEFORE the commit and
    // fall through to the array comma rule
    expect(parseFails("[x forever]")).toBe(true);
    expect(parseFailsWith("[x forever]", /comprehension/)).toBe(false);
  });

  it("reports a missing in keyword", () => {
    // the binder greedily reads the word `in` as its name, so the
    // commit fires at the missing `in` position (over `xs`)
    expect(parseFailsWith("[x for in xs]", /expected `in`/)).toBe(true);
  });

  it("reports a missing filter condition", () => {
    expect(parseFailsWith("[x for x in xs if]", /condition/)).toBe(true);
  });

  it("reports an unclosed comprehension", () => {
    expect(parseFailsWith("[x for x in xs", /close/)).toBe(true);
  });

  it("rejects a missing body expression, via the array comma rule", () => {
    // `[for x in xs]` parses `for` as the body expression, so the
    // comprehension never reaches its commit point (the keyword is
    // consumed as a name and ` x` is not `for `). It fails as an
    // array missing its commas instead - a generic error, but at the
    // right position
    expect(parseFails("[for x in xs]")).toBe(true);
  });

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

describe("bracketAccessParser (chained bracket literals)", () => {
  // A dotted `.name(...)` is parsed by dotMethodCallParser and tagged
  // kind: "methodCall". A dotted bare `.name` is kind: "property". A
  // trailing `[i]` is "index", `[a:b]` is "slice", and a bare `(args)`
  // applied to a previous chain result is "call". These kinds are asserted
  // below exactly as the parser emits them - verified against the source.
  it("parses a method call on a comprehension", () => {
    const node = parseExpr('["- ${c}" for c in xs].join("\\n")');
    expect(node.type).toBe("valueAccess");
    expect(node.base.type).toBe("comprehension");
    expect(node.chain).toHaveLength(1);
    expect(node.chain[0].kind).toBe("methodCall");
  });

  it("parses a method call on a plain array literal", () => {
    const node = parseExpr('[1, 2, 3].join("-")');
    expect(node.type).toBe("valueAccess");
    expect(node.base.type).toBe("agencyArray");
    expect(node.chain[0].kind).toBe("methodCall");
  });

  it("parses a bare property access on an array literal", () => {
    const node = parseExpr("[1, 2, 3].length");
    expect(node.type).toBe("valueAccess");
    expect(node.base.type).toBe("agencyArray");
    expect(node.chain[0].kind).toBe("property");
  });

  it("parses an index on an array literal", () => {
    const node = parseExpr("[10, 20, 30][1]");
    expect(node.type).toBe("valueAccess");
    expect(node.base.type).toBe("agencyArray");
    expect(node.chain[0].kind).toBe("index");
  });

  it("parses a slice on an array literal", () => {
    const node = parseExpr("[10, 20, 30][0:2]");
    expect(node.type).toBe("valueAccess");
    expect(node.chain[0].kind).toBe("slice");
  });

  it("parses an index-then-call chain (real `call` element, length 2)", () => {
    // `[0]` is the index; the trailing `("x")` is a `call` element applied
    // to the index result. This is the only shape that produces a
    // kind: "call" element (a dotted `.m()` is "methodCall"), AND it is the
    // first chain of length 2, so it proves many1 consumes more than one
    // element. `[f, g]` are bare identifiers so the call target is a value,
    // not a number - the parser does not type-check, so this parses fine.
    const node = parseExpr('[f, g][0]("x")');
    expect(node.type).toBe("valueAccess");
    expect(node.chain).toHaveLength(2);
    expect(node.chain[0].kind).toBe("index");
    expect(node.chain[1].kind).toBe("call");
  });

  it("parses a chain on a fork comprehension", () => {
    const node = parseExpr('fork ["- ${c}" for c in xs].join("\\n")');
    // `fork` binds to the comprehension (comprehensionParser handles the
    // prefix), which then carries the chain.
    expect(node.type).toBe("valueAccess");
    expect(node.base.type).toBe("comprehension");
    expect(node.base.mode).toBe("fork");
    expect(node.chain[0].kind).toBe("methodCall");
  });

  it("leaves a bare comprehension untouched (no chain)", () => {
    // Guards against writing `many` instead of `many1`: with `many`, a bare
    // `[...]` would wrongly become a zero-length-chain valueAccess.
    const node = parseExpr("[f(x) for x in xs]");
    expect(node.type).toBe("comprehension");
  });

  it("leaves a bare array literal untouched (no chain)", () => {
    const node = parseExpr("[1, 2, 3]");
    expect(node.type).toBe("agencyArray");
  });

  it("requires adjacency: whitespace breaks the chain", () => {
    // `[1, 2, 3][0]` (adjacent) merges into an index - the index test above
    // proves that. With a SPACE between, the chain must NOT form: chain
    // elements consume no leading whitespace (chainElementParser starts at
    // `.`/`[`/`(` with no optionalSpaces). So `[1, 2, 3] [0]` leaves `[0]`
    // stranded and the whole program fails to parse. If a future change let
    // chains skip whitespace, `[1, 2, 3] [0]` would parse and this flips.
    expect(parseFails("[1, 2, 3] [0]")).toBe(true);
  });
});
