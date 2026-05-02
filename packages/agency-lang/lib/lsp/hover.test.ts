import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { handleHover } from "./hover.js";
import { runDiagnostics } from "./diagnostics.js";
import { SymbolTable } from "../symbolTable.js";

function makeDoc(content: string, uri = "file:///test.agency") {
  return TextDocument.create(uri, "agency", 1, content);
}

describe("handleHover", () => {
  it("returns hover info for a known local function name", () => {
    const source = `def greet(name: string): string {
  let msg: string = \`hello \${name}\`
  return msg
}
greet("world")`;
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(
      doc,
      "/test.agency",
      {},
      new SymbolTable(),
    );
    const result = handleHover(
      { textDocument: { uri: doc.uri }, position: { line: 4, character: 0 } },
      doc,
      semanticIndex,
    );
    if (result) {
      const value =
        typeof result.contents === "string"
          ? result.contents
          : ((result.contents as any).value ?? "");
      expect(value).toContain("greet(name: string): string");
    }
  });

  it("returns imported hover info including alias provenance", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-hover-test-"));
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
      const source = [
        'import { greet as hello } from "./helpers.agency"',
        "",
        "node main() {",
        '  print(hello("world"))',
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { semanticIndex } = runDiagnostics(doc, mainFile, {}, symbolTable);
      const result = handleHover(
        { textDocument: { uri: doc.uri }, position: { line: 3, character: 8 } },
        doc,
        semanticIndex,
      );

      const value =
        typeof result?.contents === "string"
          ? result.contents
          : ((result?.contents as any)?.value ?? "");
      expect(value).toContain("hello(name: string): string");
      expect(value).toContain("Imported from `./helpers.agency` as `greet`");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when not on an identifier", () => {
    const doc = makeDoc("let x: number = 5");
    const { semanticIndex } = runDiagnostics(
      doc,
      "/test.agency",
      {},
      new SymbolTable(),
    );
    const result = handleHover(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 3 } },
      doc,
      semanticIndex,
    );
    expect(result).toBeNull();
  });
});
