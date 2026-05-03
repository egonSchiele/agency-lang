import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleReferences } from "./references.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

describe("handleReferences", () => {
  it("finds all references to a variable in the current file", () => {
    const source = "let foo = 1\nprint(foo)\nlet bar = foo";
    const doc = makeDoc(source);
    const result = handleReferences(
      {
        textDocument: { uri: doc.uri },
        position: { line: 0, character: 4 },
        context: { includeDeclaration: true },
      },
      doc,
    );
    expect(result).toHaveLength(3);
    expect(result[0].range.start).toEqual({ line: 0, character: 4 });
    expect(result[1].range.start).toEqual({ line: 1, character: 6 });
    expect(result[2].range.start).toEqual({ line: 2, character: 10 });
  });

  it("does not match partial words", () => {
    const source = "let foobar = 1\nlet foo = 2";
    const doc = makeDoc(source);
    const result = handleReferences(
      {
        textDocument: { uri: doc.uri },
        position: { line: 1, character: 4 },
        context: { includeDeclaration: true },
      },
      doc,
    );
    expect(result).toHaveLength(1);
  });

  it("returns empty when not on a word", () => {
    const source = "let x = 1";
    const doc = makeDoc(source);
    const result = handleReferences(
      {
        textDocument: { uri: doc.uri },
        position: { line: 0, character: 6 },
        context: { includeDeclaration: true },
      },
      doc,
    );
    expect(result).toEqual([]);
  });
});
