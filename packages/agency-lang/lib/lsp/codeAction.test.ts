import { describe, it, expect } from "vitest";
import { DiagnosticSeverity, type TextEdit } from "vscode-languageserver-protocol";
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

describe("unused-import code actions", () => {
  function applyLspEdits(source: string, doc: TextDocument, edits: TextEdit[]): string {
    let out = source;
    for (const e of [...edits].sort(
      (a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start),
    )) {
      out = out.slice(0, doc.offsetAt(e.range.start)) + e.newText + out.slice(doc.offsetAt(e.range.end));
    }
    return out;
  }

  function actionsFor(source: string) {
    const doc = makeDoc(source);
    const actions = getCodeActions(
      {
        textDocument: { uri: doc.uri },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        context: { diagnostics: [] },
      },
      doc,
      new SymbolTable(),
    );
    return { doc, actions };
  }

  it("offers a Remove unused import quick fix", () => {
    const source = `import { now } from "std::date"\nnode main() { return 1 }\n`;
    const { doc, actions } = actionsFor(source);
    const remove = actions.find((a) => a.title === "Remove unused import 'now'");
    expect(remove).toBeDefined();
    const out = applyLspEdits(source, doc, remove!.edit!.changes![doc.uri]);
    expect(out).toBe(`node main() { return 1 }\n`);
  });

  it("batch-removes multiple unused names in one statement without overlapping edits", () => {
    const source = `import { a, b, c } from "./x.agency"\nnode main() { return a() }\n`;
    const { doc, actions } = actionsFor(source);
    const batch = actions.find((a) => a.title === "Remove all unused imports");
    expect(batch).toBeDefined();
    const edits = batch!.edit!.changes![doc.uri];
    expect(edits).toHaveLength(1); // one edit per statement
    const out = applyLspEdits(source, doc, edits);
    expect(out).toContain(`import { a } from "./x.agency"`);
  });

  it("offers the batch under both source kinds", () => {
    const source = `import { a } from "./x.agency"\nnode main() { return 1 }\n`;
    const { actions } = actionsFor(source);
    const kinds = actions
      .filter((a) => a.title === "Remove all unused imports")
      .map((a) => a.kind);
    expect(kinds).toContain("source.fixAll");
    expect(kinds).toContain("source.removeUnusedImports");
  });

  it("offers no lint actions for a clean file", () => {
    const source = `import { a } from "./x.agency"\nnode main() { return a() }\n`;
    const { actions } = actionsFor(source);
    expect(actions.filter((a) => a.title.startsWith("Remove"))).toEqual([]);
  });
});

describe("code-action kind filtering (context.only)", () => {
  it("returns only the batch action when the client asks for source.fixAll", () => {
    const source = `import { a, b } from "./x.agency"\nnode main() { return 1 }\n`;
    const doc = makeDoc(source);
    const actions = getCodeActions(
      {
        textDocument: { uri: doc.uri },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        context: { diagnostics: [], only: ["source.fixAll"] },
      },
      doc,
      new SymbolTable(),
    );
    expect(actions.map((a) => a.kind)).toEqual(["source.fixAll"]);
  });

  it("returns nothing lint-related when the client asks for refactor kinds", () => {
    const source = `import { a } from "./x.agency"\nnode main() { return 1 }\n`;
    const doc = makeDoc(source);
    const actions = getCodeActions(
      {
        textDocument: { uri: doc.uri },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        context: { diagnostics: [], only: ["refactor"] },
      },
      doc,
      new SymbolTable(),
    );
    expect(actions).toEqual([]);
  });
});

describe("cached lint results", () => {
  it("uses the cache instead of re-linting when provided", () => {
    // The document HAS an unused import, but the (deliberately empty) cache
    // wins — proving no re-parse happens when a valid cache is passed.
    const source = `import { a } from "./x.agency"\nnode main() { return 1 }\n`;
    const doc = makeDoc(source);
    const actions = getCodeActions(
      {
        textDocument: { uri: doc.uri },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        context: { diagnostics: [] },
      },
      doc,
      new SymbolTable(),
      { findings: [], batchEdits: [] },
    );
    expect(actions.filter((a) => a.title.startsWith("Remove"))).toEqual([]);
  });
});
