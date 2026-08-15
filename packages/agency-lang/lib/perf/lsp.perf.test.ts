import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CodeActionKind, type CodeActionParams } from "vscode-languageserver-protocol";
import { runDiagnostics } from "../lsp/diagnostics.js";
import { getCodeActions } from "../lsp/codeAction.js";
import { SymbolTable } from "../symbolTable.js";
import { manyFunctions, manyUnusedImports } from "./fixtures.js";
import { growthFactor, expectPerf, GROWTH_BOUND } from "./harness.js";

const SMALL = 250;
const LARGE = 2000;

function docOf(source: string): TextDocument {
  return TextDocument.create("file:///t.agency", "agency", 1, source);
}

// A fresh empty SymbolTable per call keeps each measurement independent (no
// cross-call caching); runDiagnostics/getCodeActions re-parse the document text
// each call, so they are re-runnable.
describe("lsp scaling", () => {
  it("runDiagnostics scales linearly in document size", () => {
    // runDiagnostics is the debounced-keystroke hot path: parse + resolve +
    // typecheck + lint + semantic index in one call. (There is no incremental
    // fast-path today, so a "re-diagnose after an edit" case would equal this.)
    // The empty SymbolTable is a deliberate simplification — a real editor
    // passes a populated one, so import resolution is skipped here; immaterial
    // for manyFunctions (no imports) and for a scaling ratio, but this is not
    // the full keystroke cost.
    const doc = docOf(manyFunctions(LARGE, { docstrings: false }));
    expect(
      runDiagnostics(doc, "/t.agency", {}, new SymbolTable()).diagnostics.length,
    ).toBeGreaterThan(0);

    const build = (n: number) => {
      const d = docOf(manyFunctions(n, { docstrings: false }));
      return () => runDiagnostics(d, "/t.agency", {}, new SymbolTable());
    };
    expectPerf("lsp:runDiagnostics", growthFactor(build, SMALL, LARGE), GROWTH_BOUND);
  });

  it("getCodeActions packages fix-all edits in time linear in finding count", () => {
    // Measure the REAL on-save fix-all path: the server reuses the lint that
    // runDiagnostics already computed (server.ts) and passes it as cachedLint,
    // so getCodeActions only packages the batch edits into text edits. Passing
    // cachedLint here isolates that packaging — without it, getCodeActions
    // re-runs parse+lint, which the lint tests already cover.
    const params: CodeActionParams = {
      textDocument: { uri: "file:///t.agency" },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [], only: [CodeActionKind.SourceFixAll] },
    };
    const cachedLintFor = (source: string) => {
      const diag = runDiagnostics(docOf(source), "/t.agency", {}, new SymbolTable());
      return { findings: diag.lintFindings, batchEdits: diag.lintBatchEdits };
    };

    const doc = docOf(manyUnusedImports(LARGE));
    expect(
      getCodeActions(params, doc, new SymbolTable(), cachedLintFor(manyUnusedImports(LARGE)))
        .length,
    ).toBeGreaterThan(0);

    const build = (n: number) => {
      const src = manyUnusedImports(n);
      const d = docOf(src);
      const cached = cachedLintFor(src);
      return () => getCodeActions(params, d, new SymbolTable(), cached);
    };
    expectPerf("lsp:codeActions", growthFactor(build, SMALL, LARGE), GROWTH_BOUND);
  });
});
