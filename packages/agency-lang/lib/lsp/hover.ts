import { Hover, HoverParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { formatSemanticHover, lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";
import { resolveTypeAtPosition } from "./typeResolution.js";
import { formatTypeHint } from "../utils/formatType.js";
import { getWordAtPosition } from "../cli/definition.js";
import { lookupBuiltinHover, lookupJsMemberHover } from "./builtinHover.js";
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";

/**
 * If the cursor's word is preceded by `<Identifier>.`, return that base
 * identifier — used to detect JS namespace member access like `JSON.parse`
 * so we can hover the member instead of the bare function name.
 */
function getDottedBase(
  source: string,
  line: number,
  column: number,
): string | null {
  const lines = source.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const lineText = lines[line];

  // Walk left from column to the start of the current word.
  let start = column;
  while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1])) {
    start--;
  }
  if (start === 0 || lineText[start - 1] !== ".") return null;

  // Walk left across the base identifier.
  let baseEnd = start - 1;
  let baseStart = baseEnd;
  while (baseStart > 0 && /[a-zA-Z0-9_]/.test(lineText[baseStart - 1])) {
    baseStart--;
  }
  if (baseStart === baseEnd) return null;
  return lineText.slice(baseStart, baseEnd);
}

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

  // Last: language primitives (success, failure, …) and JS globals.
  // Stdlib functions (print, fetch, …) come through importedFunctions and
  // are already covered by the semantic-symbol path above.
  const word = getWordAtPosition(
    source,
    params.position.line,
    params.position.character,
  );
  if (word) {
    const base = getDottedBase(
      source,
      params.position.line,
      params.position.character,
    );
    const hover = base
      ? lookupJsMemberHover(base, word)
      : lookupBuiltinHover(word);
    if (hover) {
      return { contents: { kind: "markdown", value: hover } };
    }
  }

  return null;
}
