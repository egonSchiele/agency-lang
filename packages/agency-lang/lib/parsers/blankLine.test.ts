import { describe, it, expect } from "vitest";
import { parseAgency, replaceBlankLines } from "../parser.js";

function parseWithBlankLines(input: string) {
  return parseAgency(replaceBlankLines(input), {}, false);
}

describe("blank line parsing", () => {
  it("produces a newLine node for a blank line between statements", () => {
    const input = `node main() {\n  print("a")\n\n  print("b")\n}\n`;
    const result = parseWithBlankLines(input);
    if (!result.success) throw new Error("parse failed");

    const body = (result.result.nodes[0] as any).body;
    const types = body.map((n: any) => n.type);
    expect(types).toContain("newLine");
  });

  it("collapses multiple consecutive blank lines into one newLine node", () => {
    const input = `node main() {\n  print("a")\n\n\n\n  print("b")\n}\n`;
    const result = parseWithBlankLines(input);
    if (!result.success) throw new Error("parse failed");

    const body = (result.result.nodes[0] as any).body;
    const newLines = body.filter((n: any) => n.type === "newLine");
    expect(newLines.length).toBe(1);
  });

  it("does not produce newLine nodes when there are no blank lines", () => {
    const input = `node main() {\n  print("a")\n  print("b")\n}\n`;
    const result = parseWithBlankLines(input);
    if (!result.success) throw new Error("parse failed");

    const body = (result.result.nodes[0] as any).body;
    const types = body.map((n: any) => n.type);
    expect(types).not.toContain("newLine");
  });
});
