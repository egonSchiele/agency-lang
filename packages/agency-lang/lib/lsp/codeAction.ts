import path from "path";
import fs from "fs";
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Diagnostic,
  TextEdit,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolTable } from "../symbolTable.js";
import { uriToPath } from "./uri.js";
import { getStdlibFiles, stdlibModuleName } from "../importPaths.js";
import { parseAgency } from "../parser.js";
import { runLinter } from "../linter/registry.js";
import { unusedImportsBatchEdits } from "../linter/rules/unusedImports.js";
import type { LintContext, LintEdit, LintFinding } from "../linter/types.js";

/** Dedicated source-action kind for remove-on-save. Offered alongside the
 *  generic SourceFixAll so either `editor.codeActionsOnSave` configuration
 *  triggers the removal. */
export const REMOVE_UNUSED_IMPORTS_KIND = "source.removeUnusedImports";

function lintEditToTextEdit(doc: TextDocument, e: LintEdit): TextEdit {
  return {
    range: { start: doc.positionAt(e.start), end: doc.positionAt(e.end) },
    newText: e.newText,
  };
}

// Lazily built index: symbol name → "std::module"
let stdlibIndex: Record<string, string> | null = null;

function getStdlibIndex(): Record<string, string> {
  if (stdlibIndex) return stdlibIndex;
  stdlibIndex = {};
  for (const filePath of getStdlibFiles()) {
    const moduleName = stdlibModuleName(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const exportPattern = /export\s+(?:safe\s+)?(?:def|node)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = exportPattern.exec(content)) !== null) {
      stdlibIndex[m[1]] = moduleName;
    }
  }
  return stdlibIndex;
}

/** Lint results already computed by the diagnostics pass, valid for the
 *  document's current version. When present, getCodeActions skips its own
 *  parse + lint. */
export type CachedLint = {
  findings: LintFinding[];
  batchEdits: LintEdit[];
};

export function getCodeActions(
  params: CodeActionParams,
  doc: TextDocument,
  symbolTable: SymbolTable,
  cachedLint?: CachedLint,
): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diagnostic of params.context.diagnostics) {
    const importAction = suggestMissingImport(diagnostic, doc, symbolTable);
    if (importAction) actions.push(importAction);
    const stdlibAction = suggestStdlibImport(diagnostic, doc);
    if (stdlibAction) actions.push(stdlibAction);
  }

  // `context.only` is the client's kind filter (e.g. `["source.fixAll"]` on
  // save). Kinds are hierarchical: a filter matches a kind that equals it or
  // extends it with a `.` segment. Honoring it skips the parse + lint below
  // entirely when the client asked for kinds we do not produce.
  const only = params.context.only;
  const wantsKind = (kind: string): boolean =>
    !only || only.some((o) => kind === o || kind.startsWith(`${o}.`));
  const wantsQuickFix = wantsKind(CodeActionKind.QuickFix);
  const wantsBatch =
    wantsKind(CodeActionKind.SourceFixAll) || wantsKind(REMOVE_UNUSED_IMPORTS_KIND);
  if (!wantsQuickFix && !wantsBatch) {
    return actions;
  }

  const lint = cachedLint ?? computeLint(doc);
  if (lint) {
    const findings = lint.findings.filter((f) => f.fix);
    if (wantsQuickFix) {
      for (const f of findings) {
        actions.push({
          title: f.fix!.title,
          kind: CodeActionKind.QuickFix,
          edit: { changes: { [doc.uri]: f.fix!.edits.map((e) => lintEditToTextEdit(doc, e)) } },
        });
      }
    }
    if (wantsBatch && findings.length > 0) {
      // The batch regenerates each statement ONCE with all of its unused
      // names removed (one edit per statement) — concatenating the
      // per-finding fixes instead would produce overlapping edits whenever
      // one statement has two unused names, which VS Code rejects.
      const batchEdits = lint.batchEdits.map((e) => lintEditToTextEdit(doc, e));
      for (const kind of [CodeActionKind.SourceFixAll, REMOVE_UNUSED_IMPORTS_KIND]) {
        if (!wantsKind(kind)) {
          continue;
        }
        actions.push({
          title: "Remove all unused imports",
          kind,
          edit: { changes: { [doc.uri]: batchEdits } },
        });
      }
    }
  }

  return actions;
}

/** Fallback when no valid cached lint result exists: parse the current
 *  buffer and lint it. Returns null when the buffer does not parse. */
function computeLint(doc: TextDocument): CachedLint | null {
  const source = doc.getText();
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) {
    return null;
  }
  const ctx: LintContext = { program: parsed.result, source, filePath: uriToPath(doc.uri) };
  const findings = runLinter(ctx);
  return {
    findings,
    batchEdits: findings.length > 0 ? unusedImportsBatchEdits(ctx) : [],
  };
}

/**
 * Build an edit that either merges into an existing import line or inserts a new one.
 * Scans the document for `from "modulePath"` and appends to the existing `{ ... }`.
 */
function buildImportEdit(
  symbolName: string,
  modulePath: string,
  doc: TextDocument,
): TextEdit {
  const lines = doc.getText().split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(`from "${modulePath}"`) || line.includes(`from '${modulePath}'`)) {
      const braceIdx = line.lastIndexOf("}");
      if (braceIdx !== -1) {
        return TextEdit.insert({ line: i, character: braceIdx }, `, ${symbolName}`);
      }
    }
  }
  return TextEdit.insert({ line: 0, character: 0 }, `import { ${symbolName} } from "${modulePath}"\n`);
}

function suggestMissingImport(
  diagnostic: Diagnostic,
  doc: TextDocument,
  symbolTable: SymbolTable,
): CodeAction | null {
  const match = diagnostic.message.match(/[''](\w+)['']/);
  if (!match) return null;

  const symbolName = match[1];

  for (const filePath of symbolTable.filePaths()) {
    const fileSymbols = symbolTable.getFile(filePath);
    if (!fileSymbols) continue;
    const sym = fileSymbols[symbolName];
    if (!sym) continue;

    if ("exported" in sym && !sym.exported) continue;

    const docPath = uriToPath(doc.uri);
    if (path.resolve(filePath) === path.resolve(docPath)) continue;

    let importPath = path.relative(path.dirname(docPath), filePath).split(path.sep).join("/");
    if (!importPath.startsWith(".")) importPath = "./" + importPath;

    const edit = buildImportEdit(symbolName, importPath, doc);
    return {
      title: `Add import from '${importPath}'`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: { changes: { [doc.uri]: [edit] } },
    };
  }

  return null;
}

function suggestStdlibImport(
  diagnostic: Diagnostic,
  doc: TextDocument,
): CodeAction | null {
  const match = diagnostic.message.match(/[''](\w+)['']/);
  if (!match) return null;

  const symbolName = match[1];
  const index = getStdlibIndex();
  const modulePath = index[symbolName];
  if (!modulePath) return null;

  // Check if symbol is already imported from this module
  const text = doc.getText();
  if (text.match(new RegExp(`import\\s*\\{[^}]*\\b${symbolName}\\b[^}]*\\}\\s*from\\s*["']${modulePath.replace("::", "::")}["']`))) {
    return null;
  }

  const edit = buildImportEdit(symbolName, modulePath, doc);
  return {
    title: `Add import from '${modulePath}'`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: true,
    edit: { changes: { [doc.uri]: [edit] } },
  };
}
