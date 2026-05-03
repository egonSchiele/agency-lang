import { SymbolInformation, SymbolKind } from "vscode-languageserver-protocol";
import type { SymbolTable, SymbolInfo } from "../symbolTable.js";
import { pathToUri } from "./uri.js";
import { TEMPLATE_OFFSET } from "./locations.js";

function symbolKindToLsp(kind: SymbolInfo["kind"]): SymbolKind {
  switch (kind) {
    case "function": return SymbolKind.Function;
    case "node": return SymbolKind.Module;
    case "type": return SymbolKind.TypeParameter;
    case "class": return SymbolKind.Class;
    default: return SymbolKind.Variable;
  }
}

export function getWorkspaceSymbols(
  query: string,
  symbolTable: SymbolTable,
): SymbolInformation[] {
  const results: SymbolInformation[] = [];
  const lowerQuery = query.toLowerCase();

  for (const filePath of symbolTable.filePaths()) {
    const fileSymbols = symbolTable.getFile(filePath);
    if (!fileSymbols) continue;

    for (const [name, sym] of Object.entries(fileSymbols)) {
      if (lowerQuery && !name.toLowerCase().includes(lowerQuery)) continue;

      results.push({
        name,
        kind: symbolKindToLsp(sym.kind),
        location: {
          uri: pathToUri(filePath),
          range: sym.loc
            ? { start: { line: sym.loc.line + TEMPLATE_OFFSET, character: sym.loc.col }, end: { line: sym.loc.line + TEMPLATE_OFFSET, character: sym.loc.col } }
            : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      });
    }
  }

  return results;
}
