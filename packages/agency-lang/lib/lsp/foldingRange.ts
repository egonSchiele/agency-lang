import { FoldingRange, FoldingRangeKind } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { AgencyProgram } from "../types.js";
import { walkNodes } from "../utils/node.js";

export function getFoldingRanges(
  program: AgencyProgram,
  doc: TextDocument,
): FoldingRange[] {
  const ranges: FoldingRange[] = [];

  for (const { node } of walkNodes(program.nodes)) {
    if (!node.loc) continue;

    switch (node.type) {
      case "function":
      case "graphNode":
      case "classDefinition":
      case "handleBlock":
      case "messageThread":
      case "ifElse":
      case "whileLoop":
      case "forLoop": {
        const startLine = node.loc.line;
        const endLine = doc.positionAt(node.loc.end).line;
        if (endLine > startLine) {
          ranges.push({
            startLine,
            endLine,
            kind: FoldingRangeKind.Region,
          });
        }
        break;
      }
    }
  }

  return ranges;
}
