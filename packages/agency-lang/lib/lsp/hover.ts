import { Hover, HoverParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { formatSemanticHover, lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";
import { resolveTypeAtPosition } from "./typeResolution.js";
import { formatTypeHint } from "../utils/formatType.js";
import { getWordAtPosition } from "../cli/definition.js";
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";

export function handleHover(
  params: HoverParams,
  doc: TextDocument,
  semanticIndex: SemanticIndex,
  program?: AgencyProgram,
  scopes?: ScopeInfo[],
): Hover | null {
  const source = doc.getText();

  // First try the semantic index (top-level definitions)
  const symbol = lookupSemanticSymbol(
    source,
    params.position.line,
    params.position.character,
    semanticIndex,
  );
  if (symbol) {
    return {
      contents: { kind: "markdown", value: formatSemanticHover(symbol) },
    };
  }

  // Fall back to type resolution for local variables
  if (program && scopes) {
    const varType = resolveTypeAtPosition(
      source,
      params.position.line,
      params.position.character,
      program,
      scopes,
    );
    if (varType) {
      const word = getWordAtPosition(source, params.position.line, params.position.character);
      const typeStr = formatTypeHint(varType);
      return {
        contents: {
          kind: "markdown",
          value: `\`\`\`agency\nlet ${word}: ${typeStr}\n\`\`\``,
        },
      };
    }
  }

  return null;
}
