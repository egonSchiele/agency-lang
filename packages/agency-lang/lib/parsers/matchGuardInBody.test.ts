import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

/** The statements of the first node or def in `source`. Guards have to be
 *  tested through a whole program: the match parser alone reads every form
 *  below, and the bug was in which statement parser got to the text first. */
function bodyOf(source: string): any[] {
  // Not lowered, so a match is still a matchBlock and not the ifs it becomes.
  const parsed = parseAgency(source, {}, false, false);
  if (!parsed.success) throw new Error(parsed.message ?? "parse failed");
  const owner = parsed.result.nodes.find(
    (node: any) => node.type === "graphNode" || node.type === "function",
  ) as any;
  return owner.body.filter((statement: any) => statement.type !== "newLine");
}

describe("a guarded arm in a match statement inside a body", () => {
  it.each([
    ["a bare binding", "y", "n if (n > 2) => print(n)"],
    ["a result pattern", "r", "success(v) if (v > 0) => print(v)"],
    ["an object pattern", "x", "{ age } if (age >= 18) => print(age)"],
    ["an array pattern", "x", "[first] if (first > 0) => print(first)"],
  ])("parses %s with a guard", (_name, subject, arm) => {
    const body = bodyOf(
      `node main(${subject}: any) {\n  match(${subject}) {\n    ${arm}\n    _ => print(0)\n  }\n}\n`,
    );
    expect(body.map((statement) => statement.type)).toEqual(["matchBlock"]);
    expect(body[0].cases[0].guard).toBeDefined();
  });

  it("parses a guarded block arm", () => {
    const body = bodyOf(
      `def f(y: number) {\n  match(y) {\n    n if (n > 2) => {\n      print(n)\n    }\n    _ => print(0)\n  }\n}\n`,
    );
    expect(body[0].type).toBe("matchBlock");
    expect(body[0].cases[0].guard).toBeDefined();
  });

  it("still reads a call to a function with a block as a call", () => {
    const body = bodyOf(`node main() {\n  each(items) as item {\n    print(item)\n  }\n}\n`);
    expect(body[0].type).toBe("functionCall");
  });
});
