import { Location, ReferenceParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getWordAtPosition } from "../cli/definition.js";
import { findAllOccurrences, occurrenceToRange } from "./util.js";

export function handleReferences(
  params: ReferenceParams,
  doc: TextDocument,
): Location[] {
  const source = doc.getText();
  const word = getWordAtPosition(source, params.position.line, params.position.character);
  if (!word) return [];

  return findAllOccurrences(source, word).map((occ) => ({
    uri: doc.uri,
    range: occurrenceToRange(occ),
  }));
}
