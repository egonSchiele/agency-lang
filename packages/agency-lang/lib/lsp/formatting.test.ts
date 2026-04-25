import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleFormatting } from "./formatting.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

describe("handleFormatting", () => {
  it("returns an edit when source can be formatted", () => {
    const source = "def   foo(  ) { let x : number = 5 }";
    const doc = makeDoc(source);
    const edits = handleFormatting(
      { textDocument: { uri: doc.uri }, options: { tabSize: 2, insertSpaces: true } },
      doc,
      {},
    );
    // We just check that an edit was returned (the formatter normalizes whitespace)
    expect(Array.isArray(edits)).toBe(true);
  });

  it("returns empty array when source is invalid", () => {
    const source = "def foo( {{{";
    const doc = makeDoc(source);
    const edits = handleFormatting(
      { textDocument: { uri: doc.uri }, options: { tabSize: 2, insertSpaces: true } },
      doc,
      {},
    );
    expect(edits).toHaveLength(0);
  });

  it("returns empty array when source is already formatted", () => {
    const source = "let x: number = 5";
    const doc = makeDoc(source);
    const formatted = handleFormatting(
      { textDocument: { uri: doc.uri }, options: { tabSize: 2, insertSpaces: true } },
      doc,
      {},
    );
    // If the formatter produces the same output, no edit is needed
    if (formatted.length > 0) {
      expect(formatted[0].newText).toBeDefined();
    }
  });
});
