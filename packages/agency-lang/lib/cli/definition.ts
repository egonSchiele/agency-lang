import { parseAgency } from "../parser.js";
import { AgencyProgram } from "../types.js";
import { SourceLocation } from "../types/base.js";

type DefinitionResult = {
  file: string;
  line: number;
  column: number;
} | null;

/**
 * Extract the identifier (word) at the given 0-indexed line and column
 * in the source text. Returns null if the cursor is not on an identifier.
 */
export function getWordAtPosition(
  source: string,
  line: number,
  column: number,
): string | null {
  const lines = source.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const lineText = lines[line];
  if (column < 0 || column >= lineText.length) return null;

  const ch = lineText[column];
  if (!/[a-zA-Z0-9_]/.test(ch)) return null;

  // Walk left to find start of word
  let start = column;
  while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1])) {
    start--;
  }

  // Walk right to find end of word
  let end = column;
  while (end < lineText.length - 1 && /[a-zA-Z0-9_]/.test(lineText[end + 1])) {
    end++;
  }

  return lineText.slice(start, end + 1);
}

/**
 * Build a map of symbol name → SourceLocation from the parsed program.
 * Covers graph nodes, function definitions, and type aliases.
 */
export function collectDefinitions(
  program: AgencyProgram,
): Record<string, SourceLocation> {
  const defs: Record<string, SourceLocation> = {};

  for (const node of program.nodes) {
    if (node.type === "graphNode" && node.loc) {
      defs[node.nodeName] = node.loc;
    } else if (node.type === "function" && node.loc) {
      defs[node.functionName] = node.loc;
    } else if (node.type === "typeAlias" && node.loc) {
      defs[node.aliasName] = node.loc;
    }
  }

  return defs;
}

/**
 * Find the definition of the symbol at the given cursor position.
 */
export function findDefinition(
  source: string,
  line: number,
  column: number,
  file: string,
): DefinitionResult {
  const word = getWordAtPosition(source, line, column);
  if (!word) return null;

  const result = parseAgency(source, {}, true);
  if (!result.success) return null;

  const defs = collectDefinitions(result.result);
  const loc = defs[word];
  if (!loc) return null;

  return {
    file,
    line: loc.line,
    column: loc.col,
  };
}
