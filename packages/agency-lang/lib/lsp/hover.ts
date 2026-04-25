import { Hover, HoverParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { formatSemanticHover, lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";

export function handleHover(
  params: HoverParams,
  doc: TextDocument,
  semanticIndex: SemanticIndex,
): Hover | null {
  const symbol = lookupSemanticSymbol(
    doc.getText(),
    params.position.line,
    params.position.character,
    semanticIndex,
  );
  if (!symbol) return null;

  return {
    contents: {
      kind: "markdown",
      value: formatSemanticHover(symbol),
    },
  };
}
