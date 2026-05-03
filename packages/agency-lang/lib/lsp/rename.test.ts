import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleRename, handlePrepareRename } from "./rename.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

describe("handleRename", () => {
  it("renames a variable across all usages in the file", () => {
    const source = "let foo = 1\nprint(foo)\nlet bar = foo";
    const doc = makeDoc(source);
    const result = handleRename(
      {
        textDocument: { uri: doc.uri },
        position: { line: 0, character: 4 },
        newName: "baz",
      },
      doc,
    );
    expect(result).not.toBeNull();
    const edits = result!.changes![doc.uri];
    expect(edits).toHaveLength(3);
    for (const edit of edits) {
      expect(edit.newText).toBe("baz");
    }
  });

  it("returns null when not on a word", () => {
    const source = "let x = 1";
    const doc = makeDoc(source);
    const result = handleRename(
      {
        textDocument: { uri: doc.uri },
        position: { line: 0, character: 6 },
        newName: "y",
      },
      doc,
    );
    expect(result).toBeNull();
  });
});

describe("handlePrepareRename", () => {
  it("returns range for a valid word", () => {
    const source = "let foo = 1";
    const doc = makeDoc(source);
    const result = handlePrepareRename(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 4 } },
      doc,
    );
    expect(result).not.toBeNull();
    expect(result!.start).toEqual({ line: 0, character: 4 });
    expect(result!.end).toEqual({ line: 0, character: 7 });
  });

  it("returns null when not on a word", () => {
    const source = "let x = 1";
    const doc = makeDoc(source);
    const result = handlePrepareRename(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 6 } },
      doc,
    );
    expect(result).toBeNull();
  });
});
