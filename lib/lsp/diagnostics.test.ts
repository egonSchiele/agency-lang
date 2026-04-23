import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { runDiagnostics } from "./diagnostics.js";

function makeDoc(content: string, uri = "file:///test.agency") {
  return TextDocument.create(uri, "agency", 1, content);
}

const emptySymbolTable = {};

describe("runDiagnostics", () => {
  it("returns empty diagnostics for valid code", () => {
    const doc = makeDoc("let x: number = 5");
    const { diagnostics } = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(diagnostics).toHaveLength(0);
  });

  it("returns a diagnostic with range for a parse error", () => {
    // Deliberately malformed: unclosed function
    const doc = makeDoc("def foo( {");
    const { diagnostics } = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(diagnostics.length).toBeGreaterThan(0);
    const d = diagnostics[0];
    expect(d.source).toBe("agency");
    expect(typeof d.range.start.line).toBe("number");
    expect(typeof d.range.start.character).toBe("number");
  });

  it("returns no program on parse failure", () => {
    const doc = makeDoc("this is not valid @@@");
    const result = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(result.program).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("returns the parsed program on success", () => {
    const doc = makeDoc("def greet() { let msg: string = `hello` }");
    const result = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(result.program).not.toBeNull();
  });
});
