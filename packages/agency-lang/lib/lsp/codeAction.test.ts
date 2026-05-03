import { describe, it, expect } from "vitest";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getCodeActions } from "./codeAction.js";
import { SymbolTable } from "../symbolTable.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///project/test.agency", "agency", 1, content);
}

describe("getCodeActions", () => {
  it("returns no actions with empty symbol table", () => {
    const doc = makeDoc('node main() {\n  greet("hi")\n}');
    const symbolTable = new SymbolTable();
    const params = {
      textDocument: { uri: doc.uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: {
        diagnostics: [
          {
            severity: DiagnosticSeverity.Error,
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
            message: "'greet' is not defined",
            source: "agency",
          },
        ],
      },
    };
    const actions = getCodeActions(params, doc, symbolTable);
    expect(actions).toHaveLength(0);
  });

  it("returns no actions for diagnostics without symbol names", () => {
    const doc = makeDoc("let x = 1");
    const symbolTable = new SymbolTable();
    const params = {
      textDocument: { uri: doc.uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: {
        diagnostics: [
          {
            severity: DiagnosticSeverity.Error,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: "Unexpected token",
            source: "agency",
          },
        ],
      },
    };
    const actions = getCodeActions(params, doc, symbolTable);
    expect(actions).toHaveLength(0);
  });
});
