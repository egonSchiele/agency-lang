import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  Range,
} from "vscode-languageserver-protocol";
import { runLinter } from "../linter/registry.js";
import { unusedImportsBatchEdits } from "../linter/rules/unusedImports.js";
import type { LintEdit, LintFinding } from "../linter/types.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { typeCheck } from "../typeChecker/index.js";
import { AgencyConfig } from "../config/config.js";
import { SymbolTable } from "../symbolTable.js";
import { AgencyProgram } from "../types.js";
import { CompilationUnit } from "../compilationUnit.js";
import { buildSemanticIndex, type SemanticIndex } from "./semantics.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { EDITOR_WALL_CLOCK_MS } from "../compiler/splice/runGenerator.js";
import { prepareProgram, type PipelineDiagnostic } from "../compiler/prepareProgram.js";
import { ImportResolutionError } from "../importResolutionError.js";
import { toTypeCheckError } from "../compiler/splice/report.js";

const START_OF_FILE: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function failureRange(found: PipelineDiagnostic, doc: TextDocument): Range {
  if (found.stage === "parse" && found.errorData) {
    const { line, column, length } = found.errorData;
    return {
      start: { line, character: column },
      end: { line, character: column + (length || 1) },
    };
  }
  if (found.stage === "splice") {
    const { line, col } = found.splice.loc;
    return { start: { line, character: col }, end: { line, character: col + 1 } };
  }
  if (
    found.stage === "imports" &&
    found.error instanceof ImportResolutionError &&
    found.error.loc
  ) {
    const { start, end } = found.error.loc;
    return { start: doc.positionAt(start), end: doc.positionAt(end) };
  }
  return START_OF_FILE;
}

function failureMessage(found: PipelineDiagnostic): string {
  if (found.stage === "parse" && found.errorData) {
    return found.errorData.message;
  }
  if (found.stage === "splice") {
    const error = toTypeCheckError(found.splice);
    return `${error.code}: ${error.message}`;
  }
  if (found.stage === "imports") {
    return found.error instanceof Error ? found.error.message : String(found.error);
  }
  return found.message;
}

function toEditorDiagnostic(found: PipelineDiagnostic, doc: TextDocument): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    range: failureRange(found, doc),
    message: failureMessage(found),
    source: "agency",
  };
}

type DiagnosticsResult = {
  diagnostics: Diagnostic[];
  program: AgencyProgram | null;
  info: CompilationUnit | null;
  semanticIndex: SemanticIndex;
  scopes: ScopeInfo[];
  /** Lint results for the code-action path to reuse (see DocumentState). */
  lintFindings: LintFinding[];
  lintBatchEdits: LintEdit[];
};

export function runDiagnostics(
  doc: TextDocument,
  fsPath: string,
  config: AgencyConfig,
  symbolTable: SymbolTable,
): DiagnosticsResult {
  const source = doc.getText();

  // Analysis-only path (the LSP never executes anything):
  //  - `applyTemplate: false` keeps positions in the buffer's own coordinates.
  //  - `allowTestImports` honors `import test` so migrated test files keep full
  //    editor support instead of dying on a single 0:0 error.
  //  - `keepGoing` reports a broken splice or import and still checks the rest.
  //    This is the only path where the user is looking at the file while the
  //    generator is broken, so it is where AG8003 through AG8012 matter most.
  //    And a single import must never blank the file or crash the server
  //    (updateDocument runs in a bare debounce callback).
  const prepared = prepareProgram(source, fsPath, config, {
    applyTemplate: false,
    allowTestImports: true,
    keepGoing: true,
    spliceWallClockMs: EDITOR_WALL_CLOCK_MS,
    symbolTable,
  });
  const diagnostics = prepared.diagnostics.map((found) => toEditorDiagnostic(found, doc));
  if (!prepared.ok) {
    return {
      diagnostics,
      program: null,
      info: null,
      semanticIndex: {},
      scopes: [],
      lintFindings: [],
      lintBatchEdits: [],
    };
  }
  // `parsed` is the parse as written, and with applyTemplate=false its
  // offsets index straight into `source`. That is what the linter needs.
  const { program, info, parsed: lintProgram } = prepared;

  const { errors, scopes, interruptEffectsByFunction } = typeCheck(program, config, info);

  for (const err of errors) {
    const range = err.loc
      ? {
          start: { line: err.loc.line, character: err.loc.col },
          end: { line: err.loc.line, character: err.loc.col },
        }
      : { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range,
      message: err.message,
      source: "agency",
    });
  }

  const lintCtx = { program: lintProgram, source, filePath: fsPath };
  const lintFindings = runLinter(lintCtx);
  for (const f of lintFindings) {
    diagnostics.push({
      // v1: every lint finding is a hint. When the first warning-severity
      // rule ships, replace this with a severity map — do not let it
      // silently render warnings as hints.
      severity: DiagnosticSeverity.Hint,
      tags: [DiagnosticTag.Unnecessary],
      code: f.code,
      range: { start: doc.positionAt(f.loc.start), end: doc.positionAt(f.loc.end) },
      message: f.message,
      source: "agency",
    });
  }

  return {
    diagnostics,
    program,
    info,
    semanticIndex: buildSemanticIndex(program, fsPath, symbolTable, interruptEffectsByFunction),
    scopes,
    lintFindings,
    lintBatchEdits: lintFindings.length > 0 ? unusedImportsBatchEdits(lintCtx) : [],
  };
}
