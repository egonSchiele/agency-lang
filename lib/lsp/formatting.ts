import { TextEdit, DocumentFormattingParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { AgencyConfig } from "../config.js";
import { formatSource } from "../formatter.js";

export function handleFormatting(
  _params: DocumentFormattingParams,
  doc: TextDocument,
  config: AgencyConfig,
): TextEdit[] {
  const original = doc.getText();
  const formatted = formatSource(original, config);
  if (formatted === null || formatted === original) return [];

  return [
    TextEdit.replace(
      {
        start: { line: 0, character: 0 },
        end: doc.positionAt(original.length),
      },
      formatted,
    ),
  ];
}
