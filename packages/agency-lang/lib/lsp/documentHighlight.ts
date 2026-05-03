import {
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentHighlightParams,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getWordAtPosition } from "../cli/definition.js";
import { findAllOccurrences, occurrenceToRange } from "./util.js";

export function handleDocumentHighlight(
  params: DocumentHighlightParams,
  doc: TextDocument,
): DocumentHighlight[] {
  const source = doc.getText();
  const word = getWordAtPosition(source, params.position.line, params.position.character);
  if (!word) return [];

  return findAllOccurrences(source, word).map((occ) => ({
    range: occurrenceToRange(occ),
    kind: DocumentHighlightKind.Text,
  }));
}
