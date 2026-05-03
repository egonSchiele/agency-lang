import path from "path";
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

export function getCodeActions(
  params: CodeActionParams,
  doc: TextDocument,
  symbolTable: SymbolTable,
): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diagnostic of params.context.diagnostics) {
    const importAction = suggestMissingImport(diagnostic, doc, symbolTable);
    if (importAction) actions.push(importAction);
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

    const docPath = uriToPath(doc.uri);
    // Skip if it's the same file
    if (path.resolve(filePath) === path.resolve(docPath)) continue;

    let importPath = path.relative(path.dirname(docPath), filePath);
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
