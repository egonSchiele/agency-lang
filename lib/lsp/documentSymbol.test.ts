import { describe, it, expect } from "vitest";
import { SymbolKind } from "vscode-languageserver-protocol";
import { getDocumentSymbols } from "./documentSymbol.js";
import { parseAgency } from "../parser.js";

function parse(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return r.result;
}

describe("getDocumentSymbols", () => {
  it("returns function symbols", () => {
    const program = parse("def greet() { let x: string = `hi` }");
    const symbols = getDocumentSymbols(program);
    expect(symbols.some((s) => s.name === "greet" && s.kind === SymbolKind.Function)).toBe(true);
  });

  it("returns graph node symbols", () => {
    const program = parse("node main() { let x: number = 1 }");
    const symbols = getDocumentSymbols(program);
    expect(symbols.some((s) => s.name === "main" && s.kind === SymbolKind.Module)).toBe(true);
  });

  it("returns type alias symbols", () => {
    const program = parse("type Name = string");
    const symbols = getDocumentSymbols(program);
    expect(symbols.some((s) => s.name === "Name" && s.kind === SymbolKind.TypeParameter)).toBe(true);
  });

  it("includes location info on symbols", () => {
    const program = parse("def hello() { let x: string = `hi` }");
    const symbols = getDocumentSymbols(program);
    const fn = symbols.find((s) => s.name === "hello");
    expect(fn).toBeDefined();
    if (fn) {
      expect(typeof fn.range.start.line).toBe("number");
      expect(typeof fn.range.start.character).toBe("number");
    }
  });

  it("returns empty array for a program with no top-level definitions", () => {
    const program = parse("let x: number = 5");
    const symbols = getDocumentSymbols(program);
    expect(symbols).toHaveLength(0);
  });
});
