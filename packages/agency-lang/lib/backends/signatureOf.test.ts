import { describe, it, expect } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import { parseAgency } from "../parser.js";

function sigOf(src: string): string {
  const parsed = parseAgency(src, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return "";
  const node = parsed.result.nodes.find(
    (n: any) => n.type === "function" || n.type === "graphNode",
  );
  return new AgencyGenerator().signatureOf(node as any);
}

describe("AgencyGenerator.signatureOf (for docs)", () => {
  it("is name-only: no def/export/safe keyword and no body", () => {
    expect(sigOf("export def greet(name: string): string { return name }")).toBe(
      "greet(name: string): string",
    );
  });

  it("includes the raises clause (inline set)", () => {
    expect(sigOf("def f(x: number): number raises <std::read> { return x }")).toBe(
      "f(x: number): number raises <std::read>",
    );
  });

  it("includes a named-set raises clause", () => {
    expect(sigOf("def f(): number raises Fs { return 1 }")).toBe("f(): number raises Fs");
  });

  it("wraps a long parameter list onto separate lines", () => {
    const sig = sigOf(
      "def readConfig(path: string, encoding: string, fallback: string, retries: number): string raises <std::read> { return read(path) }",
    );
    expect(sig).toBe(
      "readConfig(\n" +
        "  path: string,\n" +
        "  encoding: string,\n" +
        "  fallback: string,\n" +
        "  retries: number,\n" +
        "): string raises <std::read>",
    );
  });

  it("works for nodes (name-only, no `node` keyword)", () => {
    expect(sigOf("export node run(input: string): string { return input }")).toBe(
      "run(input: string): string",
    );
  });
});
