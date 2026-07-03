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

  it("suggests stdlib import for known stdlib function", () => {
    // `mapValues` lives in std::object and is not auto-imported, so it needs
    // an explicit import suggestion. (Array helpers like `map` are now
    // auto-imported from std::index, so they never need this action.)
    const doc = makeDoc('node main() {\n  mapValues({})\n}');
    const symbolTable = new SymbolTable();
    const params = {
      textDocument: { uri: doc.uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: {
        diagnostics: [
          {
            severity: DiagnosticSeverity.Error,
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 11 } },
            message: "'mapValues' is not defined",
            source: "agency",
          },
        ],
      },
    };
    const actions = getCodeActions(params, doc, symbolTable);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    const stdlibAction = actions.find((a) => a.title.includes("std::"));
    expect(stdlibAction).toBeDefined();
    expect(stdlibAction!.title).toContain("std::object");
  });

  it("merges into existing stdlib import", () => {
    const source =
      'import { keys } from "std::object"\nnode main() {\n  mapValues({})\n}';
    const doc = makeDoc(source);
    const symbolTable = new SymbolTable();
    const params = {
      textDocument: { uri: doc.uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: {
        diagnostics: [
          {
            severity: DiagnosticSeverity.Error,
            range: { start: { line: 2, character: 2 }, end: { line: 2, character: 11 } },
            message: "'mapValues' is not defined",
            source: "agency",
          },
        ],
      },
    };
    const actions = getCodeActions(params, doc, symbolTable);
    const stdlibAction = actions.find((a) => a.title.includes("std::object"));
    expect(stdlibAction).toBeDefined();
    // Should merge: insert ", mapValues" before the "}" rather than adding a new line
    const edit = stdlibAction!.edit!.changes![doc.uri][0];
    expect(edit.newText).toBe(", mapValues");
    expect(edit.range.start.line).toBe(0);
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
