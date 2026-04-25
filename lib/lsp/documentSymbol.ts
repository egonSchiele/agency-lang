import { DocumentSymbol, SymbolKind } from "vscode-languageserver-protocol";
import { AgencyProgram } from "../types.js";
import { SourceLocation } from "../types/base.js";
import { toUserSourceLocation } from "./locations.js";

function locToRange(loc: SourceLocation) {
  const normalized = toUserSourceLocation(loc);
  const line = normalized?.line ?? loc.line;
  return {
    start: { line, character: loc.col },
    end: { line, character: loc.col },
  };
}

export function getDocumentSymbols(program: AgencyProgram): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];

  for (const node of program.nodes) {
    if (node.type === "function" && node.loc) {
      symbols.push({
        name: node.functionName,
        kind: SymbolKind.Function,
        range: locToRange(node.loc),
        selectionRange: locToRange(node.loc),
      });
    } else if (node.type === "graphNode" && node.loc) {
      symbols.push({
        name: node.nodeName,
        kind: SymbolKind.Module,
        range: locToRange(node.loc),
        selectionRange: locToRange(node.loc),
      });
    } else if (node.type === "typeAlias" && node.loc) {
      symbols.push({
        name: node.aliasName,
        kind: SymbolKind.TypeParameter,
        range: locToRange(node.loc),
        selectionRange: locToRange(node.loc),
      });
    } else if (node.type === "classDefinition" && node.loc) {
      symbols.push({
        name: node.className,
        kind: SymbolKind.Class,
        range: locToRange(node.loc),
        selectionRange: locToRange(node.loc),
      });
    }
  }

  return symbols;
}
