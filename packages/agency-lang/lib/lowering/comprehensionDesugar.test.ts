import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { desugarComprehensionsInBody } from "./comprehensionDesugar.js";

/** `lower: false` keeps the raw comprehension node, since the real
 *  pipeline would already have desugared it. The prelude import is
 *  nodes[0], so find the node definition by its runtime tag "graphNode". */
function desugarExpr(src: string): any {
  const result = parseAgency(
    `node main() {\n  const r = ${src}\n}`,
    {},
    true,
    false,
  );
  if (!result.success) {
    throw new Error("parse failed");
  }
  const nodes = result.result.nodes as any[];
  desugarComprehensionsInBody(nodes);
  const main = nodes.find((n) => n.type === "graphNode");
  if (!main) {
    throw new Error("no node definition found");
  }
  return main.body[0].value;
}

describe("comprehensionDesugar", () => {
  it("lowers a plain comprehension to map with a block", () => {
    const out = desugarExpr("[f(x) for x in xs]");
    expect(out.type).toBe("functionCall");
    expect(out.functionName).toBe("map");
    expect(out.block.params[0].name).toBe("x");
    expect(out.block.body[0].type).toBe("returnStatement");
  });

  it("lowers a filter to a nested filter call", () => {
    const out = desugarExpr("[f(x) for x in xs if p(x)]");
    expect(out.functionName).toBe("map");
    expect(out.arguments[0].functionName).toBe("filter");
    expect(out.arguments[0].block.params[0].name).toBe("x");
  });

  it("lowers the fork form to a real fork call node", () => {
    const out = desugarExpr("fork [f(x) for x in xs]");
    // must be `fork`, not a helper - the builder keys on this name
    expect(out.functionName).toBe("fork");
    expect(out.block).toBeDefined();
  });

  // The rev-1 coverage bug: neither bodySlots nor a hardcoded key list
  // reaches a call's arguments, so this survived into the builder.
  it("desugars a comprehension nested in a call argument", () => {
    const out = desugarExpr("g([f(x) for x in xs])");
    expect(out.functionName).toBe("g");
    expect(out.arguments[0].functionName).toBe("map");
  });

  it("desugars a comprehension in an object literal field", () => {
    const out = desugarExpr("{ items: [f(x) for x in xs] }");
    expect(out.type).toBe("agencyObject");
    // AgencyObject stores fields on `entries` (lib/types/dataStructures.ts:52)
    const field = out.entries[0];
    expect(field.value.functionName).toBe("map");
  });

  it("desugars a comprehension in a binary operand", () => {
    const out = desugarExpr("g([f(x) for x in xs]) + 1");
    expect(out.type).toBe("binOpExpression");
    expect(out.left.arguments[0].functionName).toBe("map");
  });

  it("desugars nested comprehensions innermost-out", () => {
    const out = desugarExpr("[[y for y in row] for row in rows]");
    expect(out.functionName).toBe("map");
    // the inner one became the outer block's return value
    expect(out.block.body[0].value.functionName).toBe("map");
  });

  it("wraps the source in _pairsOf for a two-binder form", () => {
    const out = desugarExpr("[f(x, i) for x, i in xs]");
    expect(out.functionName).toBe("map");
    expect(out.arguments[0].functionName).toBe("_pairsOf");
    expect(out.block.params[0].name).toBe("__comprehensionItem");
    // two unpack statements then the return
    expect(out.block.body).toHaveLength(3);
  });

  it("pairs BEFORE filtering, so indices are source positions", () => {
    const out = desugarExpr("[f(x, i) for x, i in xs if p(x)]");
    // map( filter( _pairsOf(xs) ) ) - _pairsOf must be innermost
    expect(out.functionName).toBe("map");
    expect(out.arguments[0].functionName).toBe("filter");
    expect(out.arguments[0].arguments[0].functionName).toBe("_pairsOf");
  });

  it("moves a destructuring binder into a pattern const inside the body", () => {
    const out = desugarExpr("[name for {name, age} in people]");
    expect(out.block.params[0].name).toBe("__comprehensionItem");
    expect(out.block.body[0].type).toBe("assignment");
    // `pattern` is what lowerPatterns keys on; it runs AFTER us
    expect(out.block.body[0].pattern.type).toBe("objectPattern");
    expect(out.block.body[0].declKind).toBe("const");
  });

  it("handles an array-pattern binder", () => {
    const out = desugarExpr("[a for [a, b] in pairs]");
    expect(out.block.body[0].pattern.type).toBe("arrayPattern");
  });

  it("handles a destructuring first binder alongside an index binder", () => {
    const out = desugarExpr("[f(name, i) for {name}, i in people]");
    expect(out.arguments[0].functionName).toBe("_pairsOf");
    // first statement destructures pair[0], second binds pair[1]
    expect(out.block.body[0].pattern.type).toBe("objectPattern");
    expect(out.block.body[1].variableName).toBe("i");
  });

  it("gives the filter block the same unpacking as the map block", () => {
    const out = desugarExpr("[f(x, i) for x, i in xs if p(x)]");
    const filterBlock = out.arguments[0].block;
    // regression guard for the rev-1 ordering hazard: a filter with no
    // unpacking would reference unbound names
    expect(filterBlock.body).toHaveLength(3);
    expect(filterBlock.body[0].type).toBe("assignment");
  });

  it("gives each block its OWN unpack node instances", () => {
    // scope resolution stamps scope/blockDepth per enclosing block, so a
    // node instance shared between the filter block and the map block
    // would get its stamps overwritten by whichever block runs second
    const out = desugarExpr("[f(x, i) for x, i in xs if p(x)]");
    const filterBlock = out.arguments[0].block;
    expect(filterBlock.body[0]).not.toBe(out.block.body[0]);
    expect(filterBlock.body[1]).not.toBe(out.block.body[1]);
  });

  it("is idempotent", () => {
    const result = parseAgency(
      "node main() {\n  const r = [f(x) for x in xs]\n}",
      {},
      true,
      false,
    );
    const nodes = (result as any).result.nodes;
    desugarComprehensionsInBody(nodes);
    const first = JSON.stringify(nodes);
    desugarComprehensionsInBody(nodes);
    expect(JSON.stringify(nodes)).toBe(first);
  });
});
