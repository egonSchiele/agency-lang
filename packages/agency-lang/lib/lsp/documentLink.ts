import { DocumentLink } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { AgencyProgram } from "../types.js";
import { isAgencyImport, resolveAgencyImportPath } from "../importPaths.js";
import { pathToUri } from "./uri.js";

export function getDocumentLinks(
  program: AgencyProgram,
  doc: TextDocument,
  fsPath: string,
): DocumentLink[] {
  const links: DocumentLink[] = [];
  const source = doc.getText();

  for (const node of program.nodes) {
    if (node.type === "importStatement") {
      addLinkForPath(source, doc, node.modulePath, fsPath, links);
    } else if (node.type === "importNodeStatement") {
      addLinkForPath(source, doc, node.agencyFile, fsPath, links);
    }
  }

  return links;
}

function addLinkForPath(
  source: string,
  doc: TextDocument,
  importPath: string,
  fsPath: string,
  links: DocumentLink[],
): void {
  // Find the quoted import path in the source text
  for (const quote of ['"', "'"]) {
    const needle = `${quote}${importPath}${quote}`;
    let searchFrom = 0;
    while (true) {
      const idx = source.indexOf(needle, searchFrom);
      if (idx === -1) break;
      // +1 / -1 to exclude the quotes themselves
      const start = doc.positionAt(idx + 1);
      const end = doc.positionAt(idx + 1 + importPath.length);
      let targetUri: string | undefined;
      if (isAgencyImport(importPath)) {
        try {
          targetUri = pathToUri(resolveAgencyImportPath(importPath, fsPath));
        } catch {
          // can't resolve — still show link range without target
        }
      }
      links.push({
        range: { start, end },
        target: targetUri,
      });
      searchFrom = idx + needle.length;
    }
  }
}
