import { Location, ReferenceParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getWordAtPosition } from "../cli/definition.js";
import { findAllOccurrences } from "./util.js";

export function handleReferences(
  params: ReferenceParams,
  doc: TextDocument,
): Location[] {
  const source = doc.getText();
  const word = getWordAtPosition(source, params.position.line, params.position.character);
  if (!word) return [];

  const occurrences = findAllOccurrences(source, word);

  return occurrences.map((occ) => ({
    uri: doc.uri,
    range: {
      start: { line: occ.line, character: occ.character },
      end: { line: occ.line, character: occ.character + occ.length },
    },
  }));
}
