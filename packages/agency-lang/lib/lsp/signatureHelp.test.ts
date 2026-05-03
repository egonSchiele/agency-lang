import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleSignatureHelp } from "./signatureHelp.js";
import { runDiagnostics } from "./diagnostics.js";
import { SymbolTable } from "../symbolTable.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

describe("handleSignatureHelp", () => {
  it("returns signature for a function call", () => {
    // Source must be valid so the parser succeeds and semantic index is built
    const source = 'def greet(name: string, age: number) {\n  return name\n}\nnode main() {\n  greet("hi", 1)\n}';
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    // Cursor right after the opening paren: greet(|
    const result = handleSignatureHelp(
      { textDocument: { uri: doc.uri }, position: { line: 4, character: 8 } },
      doc,
      semanticIndex,
    );
    expect(result).not.toBeNull();
    expect(result!.signatures).toHaveLength(1);
    expect(result!.signatures[0].parameters).toHaveLength(2);
    expect(result!.activeParameter).toBe(0);
  });

  it("returns correct active parameter after comma", () => {
    const source = 'def greet(name: string, age: number) {\n  return name\n}\nnode main() {\n  greet("hi", 1)\n}';
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    // Cursor after the comma: greet("hi", |1)
    const result = handleSignatureHelp(
      { textDocument: { uri: doc.uri }, position: { line: 4, character: 14 } },
      doc,
      semanticIndex,
    );
    expect(result).not.toBeNull();
    expect(result!.activeParameter).toBe(1);
  });

  it("returns null when not in a function call", () => {
    const source = "let x: number = 1";
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handleSignatureHelp(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 5 } },
      doc,
      semanticIndex,
    );
    expect(result).toBeNull();
  });
});
