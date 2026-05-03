import { Range } from "vscode-languageserver-protocol";

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Occurrence = {
  line: number;
  character: number;
  length: number;
};

export function occurrenceToRange(occ: Occurrence): Range {
  return {
    start: { line: occ.line, character: occ.character },
    end: { line: occ.line, character: occ.character + occ.length },
  };
}

/**
 * Compute the character offset of the start of the given line without splitting.
 */
export function offsetOfLine(source: string, line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const idx = source.indexOf("\n", offset);
    if (idx === -1) return source.length;
    offset = idx + 1;
  }
  return offset;
}

/**
 * Find all whole-word occurrences of `word` in `source`.
 * Known limitation: matches inside string literals and comments.
 */
export function findAllOccurrences(source: string, word: string): Occurrence[] {
  const occurrences: Occurrence[] = [];
  const lines = source.split("\n");
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "g");

  for (let line = 0; line < lines.length; line++) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lines[line])) !== null) {
      occurrences.push({ line, character: match.index, length: word.length });
    }
  }

  return occurrences;
}
