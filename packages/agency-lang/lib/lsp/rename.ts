import {
  WorkspaceEdit,
  TextEdit,
  RenameParams,
  PrepareRenameParams,
  Range,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getWordAtPosition } from "../cli/definition.js";
import { findAllOccurrences } from "./util.js";

export function handlePrepareRename(
  params: PrepareRenameParams,
  doc: TextDocument,
): Range | null {
  const source = doc.getText();
  const word = getWordAtPosition(source, params.position.line, params.position.character);
  if (!word) return null;

  const line = source.split("\n")[params.position.line];
  const start = line.lastIndexOf(word, params.position.character);
  if (start === -1) return null;

  return {
    start: { line: params.position.line, character: start },
    end: { line: params.position.line, character: start + word.length },
  };
}

export function handleRename(
  params: RenameParams,
  doc: TextDocument,
): WorkspaceEdit | null {
  const source = doc.getText();
  const word = getWordAtPosition(source, params.position.line, params.position.character);
  if (!word) return null;

  const occurrences = findAllOccurrences(source, word);
  if (occurrences.length === 0) return null;

  const edits: TextEdit[] = occurrences.map((occ) => ({
    range: {
      start: { line: occ.line, character: occ.character },
      end: { line: occ.line, character: occ.character + occ.length },
    },
    newText: params.newName,
  }));

  return { changes: { [doc.uri]: edits } };
}
