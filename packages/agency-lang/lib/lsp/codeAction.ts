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
import { getStdlibFiles } from "../importPaths.js";

// Lazily built index: symbol name → "std::module"
let stdlibIndex: Record<string, string> | null = null;

function getStdlibIndex(): Record<string, string> {
  if (stdlibIndex) return stdlibIndex;
  stdlibIndex = {};
  for (const filePath of getStdlibFiles()) {
    const moduleName = path.basename(filePath, ".agency");
    const content = fs.readFileSync(filePath, "utf-8");
    const exportPattern = /export\s+(?:def|node)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = exportPattern.exec(content)) !== null) {
      stdlibIndex[m[1]] = `std::${moduleName}`;
    }
  }
  return stdlibIndex;
}

export function getCodeActions(
  params: CodeActionParams,
  doc: TextDocument,
  symbolTable: SymbolTable,
): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diagnostic of params.context.diagnostics) {
    const importAction = suggestMissingImport(diagnostic, doc, symbolTable);
    if (importAction) actions.push(importAction);
    const stdlibAction = suggestStdlibImport(diagnostic, doc);
    if (stdlibAction) actions.push(stdlibAction);
  }

  return actions;
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

    // Only suggest exported symbols
    if ("exported" in sym && !sym.exported) continue;

    const docPath = uriToPath(doc.uri);
    if (path.resolve(filePath) === path.resolve(docPath)) continue;

    let importPath = path.relative(path.dirname(docPath), filePath).split(path.sep).join("/");
    if (!importPath.startsWith(".")) importPath = "./" + importPath;

    const importLine = `import { ${symbolName} } from "${importPath}"\n`;
    return {
      title: `Add import from '${importPath}'`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [doc.uri]: [
            TextEdit.insert({ line: 0, character: 0 }, importLine),
          ],
        },
      },
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

  // Check if this import already exists in the document
  const text = doc.getText();
  if (text.includes(`from "${modulePath}"`)) return null;

  const importLine = `import { ${symbolName} } from "${modulePath}"\n`;
  return {
    title: `Add import from '${modulePath}'`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: true,
    edit: {
      changes: {
        [doc.uri]: [
          TextEdit.insert({ line: 0, character: 0 }, importLine),
        ],
      },
    },
  };
}
