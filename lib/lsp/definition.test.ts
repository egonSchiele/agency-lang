import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { handleDefinition } from "./definition.js";
import { runDiagnostics } from "./diagnostics.js";
import { buildSymbolTable } from "../symbolTable.js";

function makeDoc(content: string, uri = "file:///test.agency") {
  return TextDocument.create(uri, "agency", 1, content);
}

const source = `def greet() {
  let msg: string = \`hello\`
}
greet()`;

describe("handleDefinition", () => {
  it("returns null when cursor is not on an identifier", () => {
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, {});
    const result = handleDefinition(
      { textDocument: { uri: doc.uri }, position: { line: 1, character: 1 } },
      doc,
      "/test.agency",
      semanticIndex,
    );
    expect(result).toBeNull();
  });

  it("returns a Location when cursor is on a known local definition name", () => {
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, {});
    const result = handleDefinition(
      { textDocument: { uri: doc.uri }, position: { line: 3, character: 0 } },
      doc,
      "/test.agency",
      semanticIndex,
    );
    expect(result?.uri).toBe("file:///test.agency");
    expect(result?.range.start.line).toBe(0);
  });

  it("returns the imported definition location for aliased symbols", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-definition-test-"));
    try {
      const helperFile = path.join(tmpDir, "helpers.agency");
      const mainFile = path.join(tmpDir, "main.agency");
      fs.writeFileSync(
        helperFile,
        [
          "export def greet(name: string): string {",
          "  return name",
          "}",
          "",
        ].join("\n"),
      );
      const mainSource = [
        'import tool { greet as hello } from "./helpers.agency"',
        "",
        "node main() {",
        '  print(hello("world"))',
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, mainSource);

      const doc = makeDoc(mainSource, `file://${mainFile}`);
      const symbolTable = buildSymbolTable(mainFile, {});
      const { semanticIndex } = runDiagnostics(doc, mainFile, {}, symbolTable);
      const result = handleDefinition(
        { textDocument: { uri: doc.uri }, position: { line: 3, character: 8 } },
        doc,
        mainFile,
        semanticIndex,
      );

      expect(result?.uri).toBe(`file://${helperFile}`);
      expect(result?.range.start.line).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
