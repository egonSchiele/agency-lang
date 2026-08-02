import { describe, expect, it } from "vitest";
import { parseAgency } from "@/parser.js";

function parseRaw(source: string) {
  const parsed = parseAgency(source, {}, false, false);
  if (!parsed.success) {
    throw new Error(`expected parse success: ${parsed.message}`);
  }
  return parsed.result;
}

function mainBody(source: string): any[] {
  return (parseRaw(source).nodes[0] as any).body;
}

describe("complete-construct trailing comment attachment", () => {
  it("attaches to a top-level declaration", () => {
    const nodes = parseRaw(`type UserId = string // identifier\n`).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].trailingComment).toMatchObject({
      type: "comment",
      content: " identifier",
    });
  });

  it("attaches to a body statement instead of adding a sibling", () => {
    const body = mainBody(
      `node main() {\n  const x = 5 // explains x\n  const y = 6\n}\n`,
    );
    expect(body).toHaveLength(2);
    expect(body[0].trailingComment?.content).toBe(" explains x");
  });

  it.each([
    ["assignment", `const x = 5`],
    ["return", `return 5`],
    ["raise", `raise("stop")`],
    ["call", `print(1)`],
    ["block", `if (true) {\n    print(1)\n  }`],
  ])("does not attach a standalone comment after %s", (_name, statement) => {
    const body = mainBody(
      `node main() {\n  ${statement}\n  // standalone\n  print(2)\n}\n`,
    );
    expect(body[0].trailingComment).toBeUndefined();
    expect(body.some((node) => node.type === "comment")).toBe(true);
  });

  it("does not attach to a blank-line node", () => {
    const body = mainBody(
      `node main() {\n  print(1)\n\n  // standalone\n  print(2)\n}\n`,
    );
    const blank = body.find((node) => node.type === "newLine");
    expect(blank?.trailingComment).toBeUndefined();
    expect(body.some((node) => node.type === "comment")).toBe(true);
  });

  it("does not extend the owner location through the comment", () => {
    const source = `type UserId = string // identifier\n`;
    const node = parseRaw(source).nodes[0];
    expect(node.trailingComment?.content).toBe(" identifier");
    expect(source.slice(node.loc!.start, node.loc!.end)).not.toContain("//");
  });

  it("attaches to a match arm without swallowing the next arm", () => {
    const body = mainBody(
      `node main() {\n  match (x) {\n    1 => "one" // first\n    2 => "two"\n  }\n}\n`,
    );
    const cases = body[0].cases.filter(
      (entry: any) => entry.type === "matchBlockCase",
    );
    expect(cases).toHaveLength(2);
    expect(cases[0].trailingComment?.content).toBe(" first");
    expect(cases[1].trailingComment).toBeUndefined();
  });

  it("does not attach a block comment", () => {
    const body = mainBody(
      `node main() {\n  const x = 5 /* why */\n  const y = 6\n}\n`,
    );
    expect(body[0].trailingComment).toBeUndefined();
  });
});
