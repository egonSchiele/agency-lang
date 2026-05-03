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
