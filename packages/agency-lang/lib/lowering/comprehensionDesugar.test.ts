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
  if (!result.success) throw new Error("parse failed");
  const nodes = result.result.nodes as any[];
  desugarComprehensionsInBody(nodes);
  const main = nodes.find((n) => n.type === "graphNode");
  if (!main) throw new Error("no node definition found");
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
