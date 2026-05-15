import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runDiagnostics } from "./diagnostics.js";
import { SymbolTable } from "../symbolTable.js";

function makeDoc(content: string, uri = "file:///test.agency") {
  return TextDocument.create(uri, "agency", 1, content);
}

const emptySymbolTable = new SymbolTable();

describe("runDiagnostics", () => {
  it("returns empty diagnostics for valid code", () => {
    const doc = makeDoc("let x: number = 5");
    const { diagnostics } = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(diagnostics).toHaveLength(0);
  });

  it("returns a diagnostic with range for a parse error", () => {
    // Deliberately malformed: unclosed function
    const doc = makeDoc("def foo( {");
    const { diagnostics } = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(diagnostics.length).toBeGreaterThan(0);
    const d = diagnostics[0];
    expect(d.source).toBe("agency");
    expect(typeof d.range.start.line).toBe("number");
    expect(typeof d.range.start.character).toBe("number");
  });

  it("returns no program on parse failure", () => {
    const doc = makeDoc("this is not valid @@@");
    const result = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(result.program).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("returns the parsed program on success", () => {
    const doc = makeDoc("def greet() { let msg: string = `hello` }");
    const result = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(result.program).not.toBeNull();
  });
});

describe("runDiagnostics — stdlib auto-import parity with CLI", () => {
  // The CLI parser template prepends a fixed `import { print, … } from "std::index"`
  // line regardless of whatever the user wrote (see
  // lib/templates/backends/agency/template.mustache). The LSP must mirror
  // that — even when the user already imports a *subset* of names from
  // std::index, the auto-imports must still be visible so call sites like
  // `print(x)` don't get a false "undefined" warning.
  it("recognizes auto-imports even when user imports a subset from std::index", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-stdlib-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      const source = [
        'import { range } from "std::index"',
        "node main() {",
        "  let xs = range(0, 3)",
        '  print("hi")',
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { diagnostics } = runDiagnostics(
        doc,
        mainFile,
        { typechecker: { undefinedFunctions: "warn" } },
        symbolTable,
      );
      const printNotDefined = diagnostics.filter(
        (d) => d.message.includes("print") && d.message.includes("not defined"),
      );
      expect(printNotDefined).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
