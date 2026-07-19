import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { desugarComprehensionsInBody } from "./comprehensionDesugar.js";
import { typeCheck } from "../typeChecker/index.js";

describe("comprehensionDesugar source locations", () => {
  it("stamps the comprehension location onto every synthesized node", () => {
    const src = "node main() {\n  const r = [f(x) for x in xs if p(x)]\n}";
    const result = parseAgency(src, {}, true, false);
    if (!(result as any).success) throw new Error("parse failed");
    const nodes = (result as any).result.nodes;
    const main = nodes.find((n: any) => n.type === "graphNode");

    const before = main.body[0].value.loc;
    expect(before).toBeDefined();
    const { line, col } = before;

    desugarComprehensionsInBody(nodes);
    const out = main.body[0].value;

    // the outer map, the inner filter, and both blocks must carry the
    // comprehension's position, not be left undefined
    expect(out.loc?.line).toBe(line);
    expect(out.loc?.col).toBe(col);
    expect(out.arguments[0].loc?.line).toBe(line);
    expect(out.block.loc?.line).toBe(line);
  });

  it("reports a type error inside a comprehension body at the user's line", () => {
    // The error is a wrong-arity call. A wrong-TYPE call would not error:
    // map's block parameter is `any`, exactly as in a hand-written
    // `map(xs) as x { ... }`, so element types do not flow (probed).
    const src = [
      "def wants(n: number): number {",
      "  return n",
      "}",
      "",
      "node main() {",
      '  const xs = ["a", "b"]',
      "  const r = [wants() for x in xs]",
      "}",
    ].join("\n");

    // typeCheck takes a parsed AgencyProgram (lib/typeChecker/index.ts),
    // not a source string - parse (with lowering, as the real pipeline
    // does) and then check.
    const parsed = parseAgency(src);
    if (!(parsed as any).success) throw new Error("parse failed");
    const { errors } = typeCheck((parsed as any).result);
    expect(errors.length).toBeGreaterThan(0);

    // The comprehension is the 7th source line. parseAgency normalizes
    // loc.line to be 0-INDEXED in the user's source (lib/parser.ts and
    // docs/dev/locations.md), so the expected line is 6. The column is
    // the call's own position - the carried node keeps its real loc
    // through the desugar rather than being restamped.
    const onComprehensionLine = errors.filter((d) => d.loc?.line === 6);
    expect(onComprehensionLine.length).toBeGreaterThan(0);
  });
});
