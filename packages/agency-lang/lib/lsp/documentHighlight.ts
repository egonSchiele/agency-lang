import {
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentHighlightParams,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getWordAtPosition } from "../cli/definition.js";

export function handleDocumentHighlight(
  params: DocumentHighlightParams,
  doc: TextDocument,
): DocumentHighlight[] {
  const source = doc.getText();
  const word = getWordAtPosition(source, params.position.line, params.position.character);
  if (!word) return [];

  const highlights: DocumentHighlight[] = [];
  const lines = source.split("\n");
  // Match whole-word occurrences using word boundary regex
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "g");

  for (let line = 0; line < lines.length; line++) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lines[line])) !== null) {
      highlights.push({
        range: {
          start: { line, character: match.index },
          end: { line, character: match.index + word.length },
        },
        kind: DocumentHighlightKind.Text,
      });
    }
  }

  return highlights;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
