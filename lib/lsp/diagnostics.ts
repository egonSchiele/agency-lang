import {
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parseAgency } from "../parser.js";
import { resolveImports } from "../preprocessors/importResolver.js";
import { collectProgramInfo } from "../programInfo.js";
import { typeCheck } from "../typeChecker/index.js";
import { AgencyConfig } from "../config.js";
import { SymbolTable } from "../symbolTable.js";
import { AgencyProgram } from "../types.js";
import { ProgramInfo } from "../programInfo.js";
import { buildSemanticIndex, type SemanticIndex } from "./semantics.js";
import { TEMPLATE_OFFSET } from "./locations.js";

type DiagnosticsResult = {
  diagnostics: Diagnostic[];
  program: AgencyProgram | null;
  info: ProgramInfo | null;
  semanticIndex: SemanticIndex;
};

export function runDiagnostics(
  doc: TextDocument,
  fsPath: string,
  config: AgencyConfig,
  symbolTable: SymbolTable,
): DiagnosticsResult {
  const source = doc.getText();
  const diagnostics: Diagnostic[] = [];

  const parseResult = parseAgency(source, config, false);
  if (!parseResult.success) {
    const ed = parseResult.errorData;
    if (ed) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: ed.line, character: ed.column },
          end: { line: ed.line, character: ed.column + (ed.length || 1) },
        },
        message: ed.message,
        source: "agency",
      });
    } else {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: parseResult.message ?? "Parse error",
        source: "agency",
      });
    }
    return { diagnostics, program: null, info: null, semanticIndex: {} };
  }

  let program = parseResult.result;

  try {
    program = resolveImports(program, symbolTable, fsPath);
  } catch (err) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: err instanceof Error ? err.message : String(err),
      source: "agency",
    });
    return { diagnostics, program: null, info: null, semanticIndex: {} };
  }

  const info = collectProgramInfo(program, symbolTable);
  const { errors } = typeCheck(program, config, info);

  for (const err of errors) {
    const range = err.loc
      ? {
          start: { line: err.loc.line + TEMPLATE_OFFSET, character: err.loc.col },
          end: doc.positionAt(err.loc.end),
        }
      : { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range,
      message: err.message,
      source: "agency",
    });
  }

  return {
    diagnostics,
    program,
    info,
    semanticIndex: buildSemanticIndex(program, fsPath, symbolTable),
  };
}
