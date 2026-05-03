import { Location, DefinitionParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { findDefinition, getWordAtPosition } from "../cli/definition.js";
import { pathToUri } from "./uri.js";
import { lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { findContainingScope } from "./scopeResolution.js";
import { walkNodes } from "../utils/node.js";

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

  // Find which scope the cursor is in
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  offset += character;

  const scope = findContainingScope(offset, scopes, program);
  if (!scope) return null;

  // Check that this variable exists in the scope
  const resolved = scope.scope.lookup(word);
  if (!resolved) return null;

  // Walk the scope's body to find the first assignment with this variable name
  for (const { node } of walkNodes(scope.body)) {
    if (node.type === "assignment" && node.variableName === word && node.declKind && node.loc) {
      return { line: node.loc.line, character: node.loc.col };
    }
  }

  // Check function/node parameters
  for (const topNode of program.nodes) {
    if (topNode.type === "function" && topNode.functionName === scope.name) {
      const param = topNode.parameters.find((p) => p.name === word);
      if (param && topNode.loc) {
        return { line: topNode.loc.line, character: topNode.loc.col };
      }
    }
    if (topNode.type === "graphNode" && topNode.nodeName === scope.name) {
      const param = topNode.parameters.find((p) => p.name === word);
      if (param && topNode.loc) {
        return { line: topNode.loc.line, character: topNode.loc.col };
      }
    }
  }

  return null;
}
