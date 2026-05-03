import { describe, it, expect } from "vitest";
import { DocumentHighlightKind } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleDocumentHighlight } from "./documentHighlight.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

describe("handleDocumentHighlight", () => {
  it("highlights all occurrences of a word", () => {
    const doc = makeDoc("let foo = 1\nprint(foo)\nlet bar = foo");
    const result = handleDocumentHighlight(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 4 } },
      doc,
    );
    expect(result).toHaveLength(3);
    expect(result[0].kind).toBe(DocumentHighlightKind.Text);
    expect(result[0].range.start).toEqual({ line: 0, character: 4 });
    expect(result[1].range.start).toEqual({ line: 1, character: 6 });
    expect(result[2].range.start).toEqual({ line: 2, character: 10 });
  });

  it("returns empty array when not on a word", () => {
    const doc = makeDoc("let x = 1");
    const result = handleDocumentHighlight(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 6 } },
      doc,
    );
    expect(result).toEqual([]);
  });

  it("does not match partial words", () => {
    const doc = makeDoc("let foobar = 1\nlet foo = 2");
    const result = handleDocumentHighlight(
      { textDocument: { uri: doc.uri }, position: { line: 1, character: 4 } },
      doc,
    );
    expect(result).toHaveLength(1);
    expect(result[0].range.start).toEqual({ line: 1, character: 4 });
  });
});
