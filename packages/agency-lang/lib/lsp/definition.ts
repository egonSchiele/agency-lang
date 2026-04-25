import { Location, DefinitionParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { findDefinition } from "../cli/definition.js";
import { pathToUri } from "./uri.js";
import { lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";

export function handleDefinition(
  params: DefinitionParams,
  doc: TextDocument,
  fsPath: string,
  semanticIndex: SemanticIndex,
): Location | null {
  const symbol = lookupSemanticSymbol(
    doc.getText(),
    params.position.line,
    params.position.character,
    semanticIndex,
  );

  if (symbol?.loc) {
    return {
      uri: pathToUri(symbol.filePath),
      range: {
        start: { line: symbol.loc.line, character: symbol.loc.col },
        end: { line: symbol.loc.line, character: symbol.loc.col },
      },
    };
  }

  const result = findDefinition(
    doc.getText(),
    params.position.line,
    params.position.character,
    fsPath,
  );
  if (!result) return null;

  return {
    uri: pathToUri(result.file),
    range: {
      start: { line: result.line, character: result.column },
      end: { line: result.line, character: result.column },
    },
  };
}
