import { Location, DefinitionParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { findDefinition, getWordAtPosition } from "../cli/definition.js";
import { pathToUri } from "./uri.js";
import { lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { findContainingScope, findDefForScope } from "./scopeResolution.js";
import { walkNodes } from "../utils/node.js";
import { offsetOfLine } from "./util.js";

export function handleDefinition(
  params: DefinitionParams,
  doc: TextDocument,
  fsPath: string,
  semanticIndex: SemanticIndex,
  program?: AgencyProgram,
  scopes?: ScopeInfo[],
): Location | null {
  const source = doc.getText();

  const symbol = lookupSemanticSymbol(
    source,
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

  // Try local variable definition via AST
  if (program && scopes) {
    const loc = findLocalDefinition(source, params.position.line, params.position.character, program, scopes);
    if (loc) {
      return { uri: doc.uri, range: { start: loc, end: loc } };
    }
  }

  const result = findDefinition(
    source,
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

function findLocalDefinition(
  source: string,
  line: number,
  character: number,
  program: AgencyProgram,
  scopes: ScopeInfo[],
): { line: number; character: number } | null {
  const word = getWordAtPosition(source, line, character);
  if (!word) return null;

  const offset = offsetOfLine(source, line) + character;
  const scope = findContainingScope(offset, scopes, program);
  if (!scope) return null;

  if (!scope.scope.lookup(word)) return null;

  for (const { node } of walkNodes(scope.body)) {
    if (node.type === "assignment" && node.variableName === word && node.declKind && node.loc) {
      return { line: node.loc.line, character: node.loc.col };
    }
  }

  // Check if it's a parameter of the containing function/node
  const def = findDefForScope(scope.name, program);
  if (def && "parameters" in def) {
    const param = def.parameters.find((p) => p.name === word);
    if (param && def.loc) {
      return { line: def.loc.line, character: def.loc.col };
    }
  }

  return null;
}
