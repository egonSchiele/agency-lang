import { describe, it, expect } from "vitest";
import { CompletionItemKind } from "vscode-languageserver-protocol";
import { getCompletions } from "./completion.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";

function parse(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return r.result;
}

describe("getCompletions", () => {
  it("includes function definitions as Function items with detail", () => {
    const program = parse('def greet(name: string): string {\n  """\n  Say hello\n  """\n  return `hi ${name}`\n}');
    const info = buildCompilationUnit(program, new SymbolTable());
    const items = getCompletions(info);
    const greet = items.find((i) => i.label === "greet");
    expect(greet).toBeDefined();
    expect(greet?.kind).toBe(CompletionItemKind.Function);
    expect(greet?.detail).toBe("(name: string): string");
    expect(greet?.documentation).toBe("Say hello");
  });

  it("includes graph nodes as Module items", () => {
    const program = parse("node main() { let x: number = 1 }");
    const info = buildCompilationUnit(program, new SymbolTable());
    const items = getCompletions(info);
    const main = items.find((i) => i.label === "main");
    expect(main).toBeDefined();
    expect(main?.kind).toBe(CompletionItemKind.Module);
  });

  it("includes type aliases as TypeParameter items", () => {
    const program = parse("type Name = string\ndef use(n: Name) { }");
    const info = buildCompilationUnit(program, new SymbolTable());
    const items = getCompletions(info);
    const name = items.find((i) => i.label === "Name");
    expect(name).toBeDefined();
    expect(name?.kind).toBe(CompletionItemKind.TypeParameter);
  });

  it("deduplicates items", () => {
    const program = parse("def foo() { } \ndef foo2() { }");
    const info = buildCompilationUnit(program, new SymbolTable());
    const items = getCompletions(info);
    const labels = items.map((i) => i.label);
    const unique = new Set(labels);
    expect(labels.length).toBe(unique.size);
  });

  it("returns empty array for empty program", () => {
    const info = buildCompilationUnit(
      { type: "agencyProgram", nodes: [] },
      new SymbolTable(),
    );
    const items = getCompletions(info);
    expect(Array.isArray(items)).toBe(true);
  });
});
