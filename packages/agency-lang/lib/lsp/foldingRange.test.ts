import { describe, it, expect } from "vitest";
import { FoldingRangeKind } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getFoldingRanges } from "./foldingRange.js";
import { parseAgency } from "../parser.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

function parse(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return r.result;
}

describe("getFoldingRanges", () => {
  it("returns folding range for a function", () => {
    const source = "def greet(name: string) {\n  print(name)\n  print(name)\n}";
    const doc = makeDoc(source);
    const program = parse(source);
    const ranges = getFoldingRanges(program, doc);
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    const fn = ranges.find((r) => r.startLine === 0);
    expect(fn).toBeDefined();
    expect(fn!.endLine).toBe(3);
    expect(fn!.kind).toBe(FoldingRangeKind.Region);
  });

  it("returns folding range for a node", () => {
    const source = "node main() {\n  let x: number = 1\n  print(x)\n}";
    const doc = makeDoc(source);
    const program = parse(source);
    const ranges = getFoldingRanges(program, doc);
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    const node = ranges.find((r) => r.startLine === 0);
    expect(node).toBeDefined();
    expect(node!.endLine).toBe(3);
  });

  it("returns empty array for single-line constructs", () => {
    const source = "let x: number = 1";
    const doc = makeDoc(source);
    const program = parse(source);
    const ranges = getFoldingRanges(program, doc);
    expect(ranges).toEqual([]);
  });
});
