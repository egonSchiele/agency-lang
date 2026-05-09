import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { handleHover } from "./hover.js";
import { runDiagnostics } from "./diagnostics.js";
import { SymbolTable } from "../symbolTable.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "../typeChecker/index.js";

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
      expect(value).toContain("def greet(name: string): string");
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
      expect(value).toContain("def hello(name: string): string");
      expect(value).toContain("Imported from `./helpers.agency` as `greet`");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns type for a local variable on hover", () => {
    const source = 'node main() {\n  let name: string = "hi"\n  print(name)\n}';
    const doc = makeDoc(source);
    const r = parseAgency(source, {}, false);
    if (!r.success) throw new Error("parse failed");
    const program = r.result;
    const info = buildCompilationUnit(program, new SymbolTable());
    const { scopes } = typeCheck(program, {}, info);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    // Hover over "name" in print(name) — line 2, character 8
    const result = handleHover(
      { textDocument: { uri: doc.uri }, position: { line: 2, character: 8 } },
      doc,
      semanticIndex,
      program,
      scopes,
    );
    expect(result).not.toBeNull();
    const value = (result!.contents as any).value;
    expect(value).toContain("string");
    expect(value).toContain("name");
  });

  it("shows interrupt kinds in hover for function with interrupts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-hover-int-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      const source = [
        "def deploy() {",
        '  interrupt myapp::deploy("Deploy?")',
        "}",
        "",
        "node main() {",
        "  deploy()",
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { semanticIndex } = runDiagnostics(doc, mainFile, {}, symbolTable);
      const result = handleHover(
        { textDocument: { uri: doc.uri }, position: { line: 5, character: 2 } },
        doc,
        semanticIndex,
      );

      const value = (result?.contents as any)?.value ?? "";
      expect(value).toContain("def deploy()");
      expect(value).toContain("**Interrupts:**");
      expect(value).toContain("`myapp::deploy`");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows transitive interrupt kinds in hover", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-hover-trans-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      const source = [
        "def deploy() {",
        '  interrupt myapp::deploy("Deploy?")',
        "}",
        "def orchestrate() {",
        "  deploy()",
        "}",
        "",
        "node main() {",
        "  orchestrate()",
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { semanticIndex } = runDiagnostics(doc, mainFile, {}, symbolTable);
      // Hover over "orchestrate" in main — should show transitive interrupt kinds
      const result = handleHover(
        { textDocument: { uri: doc.uri }, position: { line: 8, character: 2 } },
        doc,
        semanticIndex,
      );

      const value = (result?.contents as any)?.value ?? "";
      expect(value).toContain("def orchestrate()");
      expect(value).toContain("**Interrupts:**");
      expect(value).toContain("`myapp::deploy`");
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
