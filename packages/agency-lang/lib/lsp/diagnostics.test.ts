import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity, DiagnosticTag } from "vscode-languageserver-protocol";
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

describe("runDiagnostics — every prelude name resolves", () => {
  // Regression: the LSP used to keep its own hand-copied list of the names
  // the CLI parser template auto-imports. The copy drifted — `_guard`,
  // `saveDraft`, and `flatten` were added to the template but never to the
  // LSP's list — so a file using the `guard` construct lit up with a phantom
  // "Function '_guard' is not defined" in the editor while
  // `agency typecheck` on the same file reported nothing. Both paths now
  // render the same PRELUDE_NAMES, so this asserts the drifted names in
  // particular resolve through the LSP.
  it("reports no undefined-name errors for guard, saveDraft, or flatten", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-prelude-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      const source = [
        "node main() {",
        "  const captured = guard(cost: 1.0) {",
        "    saveDraft([1, 2])",
        "    return [1, 2]",
        "  }",
        "  const flat = flatten([[1], [2]])",
        "  return flat",
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { diagnostics, program } = runDiagnostics(doc, mainFile, {}, symbolTable);

      // Without this, a grammar change that stopped the snippet parsing
      // would leave zero name-resolution diagnostics and the assertion
      // below would pass while checking nothing.
      expect(program).not.toBeNull();
      const undefinedNames = diagnostics.filter((d) =>
        /is not defined/.test(d.message),
      );
      expect(undefinedNames.map((d) => d.message)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runDiagnostics — shadowing a prelude name", () => {
  // Agency treats the prelude as overridable: a user's own `def map` wins,
  // and the compile path realizes that by dropping `map` from the injected
  // import (prunePreludeShadows). The LSP has to run the same pass or it
  // still sees the import and warns about a shadow the compiler resolved.
  it("does not warn when a user def shadows a prelude name", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-shadow-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      const source = [
        "def map(xs: number[]): number[] {",
        "  return xs",
        "}",
        "node main() {",
        "  return map([1])",
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { diagnostics, program } = runDiagnostics(doc, mainFile, {}, symbolTable);

      expect(program).not.toBeNull();
      const shadowWarnings = diagnostics.filter((d) => /shadows an imported/.test(d.message));
      expect(shadowWarnings.map((d) => d.message)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // `_guard` is exempt from pruning (UNPRUNABLE_PRELUDE_NAMES): letting a
  // user `_guard` displace the real one would silently rebind every
  // `guard(...) { }` in the file and bypass budget metering. The editor
  // must keep reporting that, not go quiet along with the shadow warnings.
  it("still reports a user def named _guard", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-guardshadow-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      const source = [
        "def _guard(x: number): number {",
        "  return x",
        "}",
        "node main() {",
        "  return _guard(1)",
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { diagnostics, program } = runDiagnostics(doc, mainFile, {}, symbolTable);

      expect(program).not.toBeNull();
      const messages = diagnostics.map((d) => d.message);
      // The shadow warning must survive the pruning pass for this name
      // specifically, and the reserved-name error rides alongside it.
      expect(messages).toContain("'_guard' shadows an imported function.");
      expect(messages).toContain(
        "'_guard' is a reserved built-in; cannot be redefined.",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runDiagnostics — unsaved edits use the editor buffer", () => {
  // The reported bug: the LSP built its symbol table from the *saved* file but
  // ran diagnostics on the *editor buffer*. Typing `import { now } from
  // "std::date"` before saving left the symbol table unaware of std::date, so
  // `resolveImports` rejected `now` ("Symbol 'now' is not defined in
  // 'std::date'") and — because that threw before the type checker ran — every
  // other squiggle in the file vanished. The server now feeds the buffer into
  // SymbolTable.build via an override, so a just-typed import resolves without
  // a save. These tests drive that override the same way the server does.
  function buildWithBuffer(mainFile: string, buffer: string): SymbolTable {
    return SymbolTable.build(mainFile, {}, { [path.resolve(mainFile)]: buffer });
  }

  it("resolves a just-typed import that the saved file lacks", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-unsaved-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      // Saved on disk: no import yet.
      fs.writeFileSync(
        mainFile,
        ["node main() {", "  print(now())", "}", ""].join("\n"),
      );
      // Editor buffer: the import has been typed but not saved.
      const buffer = [
        'import { now } from "std::date"',
        "node main() {",
        "  print(now())",
        "}",
        "",
      ].join("\n");

      const doc = makeDoc(buffer, `file://${mainFile}`);
      const { diagnostics, program } = runDiagnostics(
        doc,
        mainFile,
        {},
        buildWithBuffer(mainFile, buffer),
      );

      expect(program).not.toBeNull();
      expect(diagnostics.map((d) => d.message)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps unrelated diagnostics when only some names are imported", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-partial-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      fs.writeFileSync(
        mainFile,
        ["node main() {", "  print(now())", "}", ""].join("\n"),
      );
      // Buffer imports `now` but not `elapsedTime`. The `elapsedTime` squiggle
      // must survive — the old code wiped it by aborting before type-checking.
      const buffer = [
        'import { now } from "std::date"',
        "node main() {",
        "  const start = now()",
        "  print(elapsedTime(since: start))",
        "}",
        "",
      ].join("\n");

      const doc = makeDoc(buffer, `file://${mainFile}`);
      const { diagnostics } = runDiagnostics(
        doc,
        mainFile,
        {},
        buildWithBuffer(mainFile, buffer),
      );

      const messages = diagnostics.map((d) => d.message);
      expect(messages).toContain("Function 'elapsedTime' is not defined.");
      // The bogus "Symbol 'now' is not defined in 'std::date'" must be gone.
      expect(messages.some((m) => /'now'.*not defined in/.test(m))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runDiagnostics — an unresolvable import degrades gracefully", () => {
  // A single bad import must not blank out the file: the type checker still
  // runs, good imports still resolve, and the bad import is reported once (by
  // the checker's checkMissingImports pass) at its own location.
  it("reports the bad import once and still resolves the good one", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-baddimp-"));
    try {
      const mainFile = path.join(tmpDir, "main.agency");
      const source = [
        'import { now } from "std::date"',
        'import { doesNotExist } from "std::date"',
        "node main() {",
        "  print(now())",
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { diagnostics, program } = runDiagnostics(doc, mainFile, {}, symbolTable);

      expect(program).not.toBeNull();
      const messages = diagnostics.map((d) => d.message);
      // The bad name is reported exactly once, not duplicated.
      const badImportErrors = messages.filter((m) =>
        /'doesNotExist'.*not defined in/.test(m),
      );
      expect(badImportErrors).toHaveLength(1);
      // The good import still resolves: `now` must not read as undefined.
      expect(messages.some((m) => /'now' is not defined/.test(m))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runDiagnostics — test-only imports", () => {
  // The LSP is an analysis-only path: it must honor `import test` so
  // migrated test files keep full editor support instead of dying on a
  // single 0:0 "only allowed under the test harness" error with no program.
  it("does not fatal-error on import test of a non-exported symbol", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-testimp-"));
    try {
      const helperFile = path.join(tmpDir, "helpers.agency");
      fs.writeFileSync(
        helperFile,
        ["def secretDouble(n: number): number {", "  return n * 2", "}", ""].join("\n"),
      );
      const mainFile = path.join(tmpDir, "main.agency");
      const source = [
        'import test { secretDouble } from "./helpers.agency"',
        "node main() {",
        "  return secretDouble(21)",
        "}",
        "",
      ].join("\n");
      fs.writeFileSync(mainFile, source);

      const doc = makeDoc(source, `file://${mainFile}`);
      const symbolTable = SymbolTable.build(mainFile, {});
      const { diagnostics, program } = runDiagnostics(doc, mainFile, {}, symbolTable);

      expect(program).not.toBeNull();
      const harnessErrors = diagnostics.filter((d) =>
        /only allowed under the test harness/.test(d.message),
      );
      expect(harnessErrors).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("lint diagnostics", () => {
  it("emits a Hint diagnostic tagged Unnecessary for an unused import", () => {
    const source = `import { now } from "std::date"\nnode main() { return 1 }\n`;
    const doc = makeDoc(source);
    const { diagnostics } = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    const lint = diagnostics.find((d) => d.code === "AL0001");
    expect(lint).toBeDefined();
    expect(lint!.severity).toBe(DiagnosticSeverity.Hint);
    expect(lint!.tags).toContain(DiagnosticTag.Unnecessary);
    // The grayed range covers only the name 'now'.
    expect(source.slice(
      doc.offsetAt(lint!.range.start),
      doc.offsetAt(lint!.range.end),
    )).toBe("now");
  });

  it("does not gray out the injected prelude names", () => {
    const source = `node main() { return 1 }\n`;
    const doc = makeDoc(source);
    const { diagnostics } = runDiagnostics(doc, "/test.agency", {}, emptySymbolTable);
    expect(diagnostics.filter((d) => d.code === "AL0001")).toEqual([]);
  });
});
