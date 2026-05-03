import { Location, TypeDefinitionParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { resolveTypeAtPosition } from "./typeResolution.js";
import type { SemanticIndex } from "./semantics.js";
import { pathToUri } from "./uri.js";
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";

export function handleTypeDefinition(
  params: TypeDefinitionParams,
  doc: TextDocument,
  program: AgencyProgram,
  scopes: ScopeInfo[],
  semanticIndex: SemanticIndex,
): Location | null {
  const varType = resolveTypeAtPosition(
    doc.getText(),
    params.position.line,
    params.position.character,
    program,
    scopes,
  );
  if (!varType) return null;

  let typeName: string | null = null;
  if (varType.type === "typeAliasVariable") {
    typeName = varType.aliasName;
  }

  if (!typeName) return null;

  const symbol = semanticIndex[typeName];
  if (!symbol?.loc) return null;

  return {
    uri: pathToUri(symbol.filePath),
    range: {
      start: { line: symbol.loc.line, character: symbol.loc.col },
      end: { line: symbol.loc.line, character: symbol.loc.col },
    },
  };
}
