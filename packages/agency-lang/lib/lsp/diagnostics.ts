import {
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parseAgency } from "../parser.js";
import { resolveImports } from "../preprocessors/importResolver.js";
import { resolveReExports } from "../preprocessors/resolveReExports.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "../typeChecker/index.js";
import { AgencyConfig } from "../config.js";
import { SymbolTable } from "../symbolTable.js";
import { AgencyProgram } from "../types.js";
import { CompilationUnit } from "../compilationUnit.js";
import { buildSemanticIndex, type SemanticIndex } from "./semantics.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { ImportStatement } from "../types/importStatement.js";
import { resolveAgencyImportPath } from "../importPaths.js";

// Names auto-imported from std::index by the parser template. Kept in sync
// with lib/templates/backends/agency/template.mustache.
const STDLIB_AUTO_IMPORTS: string[] = [
  "print", "printJSON", "parseJSON", "input", "sleep", "round", "fetch",
  "fetchJSON", "read", "write", "readImage", "notify", "range",
  "mostCommon", "keys", "values", "entries", "emit",
];

/**
 * Inject a synthetic `import { ... } from "std::index"` if the program
 * doesn't already have one AND the SymbolTable has std::index loaded.
 * Returns the original program unchanged otherwise.
 *
 * Skipping when the SymbolTable doesn't have std::index avoids generating
 * downstream "Symbol 'print' is not defined in std::index" errors when
 * tests pass an empty SymbolTable.
 */
function ensureStdlibImport(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  fsPath: string,
): AgencyProgram {
  for (const node of program.nodes) {
    if (node.type === "importStatement" && node.modulePath === "std::index") {
      return program;
    }
  }
  let stdlibPath: string;
  try {
    stdlibPath = resolveAgencyImportPath("std::index", fsPath);
  } catch {
    return program;
  }
  if (!symbolTable.has(stdlibPath)) return program;
  const synthetic: ImportStatement = {
    type: "importStatement",
    importedNames: [
      {
        type: "namedImport",
        importedNames: STDLIB_AUTO_IMPORTS,
        safeNames: [],
        aliases: {},
      },
    ],
    modulePath: "std::index",
    isAgencyImport: true,
  };
  return { ...program, nodes: [synthetic, ...program.nodes] };
}

type DiagnosticsResult = {
  diagnostics: Diagnostic[];
  program: AgencyProgram | null;
  info: CompilationUnit | null;
  semanticIndex: SemanticIndex;
  scopes: ScopeInfo[];
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
    return { diagnostics, program: null, info: null, semanticIndex: {}, scopes: [] };
  }

  let program = parseResult.result;

  // The CLI parses source through a template that auto-injects an
  // `import { ... } from "std::index"` statement. The LSP path uses
  // `applyTemplate: false` so editor positions match the user's source —
  // but that means stdlib calls (`print`, `read`, …) would resolve as
  // undefined here. Synthesize the same import so they resolve through
  // `importedFunctions` like in the CLI flow.
  program = ensureStdlibImport(program, symbolTable, fsPath);

  try {
    program = resolveReExports(program, symbolTable, fsPath);
    program = resolveImports(program, symbolTable, fsPath);
  } catch (err) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: err instanceof Error ? err.message : String(err),
      source: "agency",
    });
    return { diagnostics, program: null, info: null, semanticIndex: {}, scopes: [] };
  }

  const info = buildCompilationUnit(program, symbolTable, fsPath, source);
  const { errors, scopes, interruptKindsByFunction } = typeCheck(program, config, info);

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

  return {
    diagnostics,
    program,
    info,
    semanticIndex: buildSemanticIndex(program, fsPath, symbolTable, interruptKindsByFunction),
    scopes,
  };
}
