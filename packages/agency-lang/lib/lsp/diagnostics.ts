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
import { PRELUDE_NAMES } from "../prelude.js";
import { prunePreludeShadows } from "../preprocessors/prunePreludeShadows.js";

/**
 * Inject a synthetic `import { ... } from "std::index"` so the LSP sees the
 * same auto-imports the CLI parser template prepends. Both render the same
 * PRELUDE_NAMES (lib/prelude.ts) so the editor and the compiler cannot
 * disagree about what is in scope. The synthetic is added
 * unconditionally (alongside any user `import … from "std::index"`) so a
 * user who imports a *subset* like `import { range } from "std::index"`
 * still gets `print`, `read`, etc. from the auto-imports — matching CLI
 * behavior where the template prepends a separate fixed import line.
 *
 * Skipped when the SymbolTable doesn't have std::index loaded — that's
 * the test-with-empty-SymbolTable case and synthesizing here would just
 * produce downstream "Symbol 'print' is not defined" noise.
 */
function ensureStdlibImport(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  fsPath: string,
): AgencyProgram {
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
        importedNames: [...PRELUDE_NAMES],
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
  // Agency treats the prelude as overridable, and the compile path realizes
  // that by dropping a shadowed name from the injected import
  // (typescriptPreprocessor.ts). The LSP has to run the same pass or it
  // warns about shadows the compiler already resolved. Pure AST mutation,
  // no codegen dependency, so it is safe on this analysis-only path.
  prunePreludeShadows(program);

  try {
    program = resolveReExports(program, symbolTable, fsPath);
    // Analysis-only path (the LSP never executes anything): honor
    // `import test` so migrated test files keep full editor support instead
    // of dying on a single 0:0 error. Execution paths still default to deny.
    program = resolveImports(program, symbolTable, fsPath, {
      allowTestImports: true,
    });
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

  return {
    diagnostics,
    program,
    info,
    semanticIndex: buildSemanticIndex(program, fsPath, symbolTable, interruptEffectsByFunction),
    scopes,
  };
}
