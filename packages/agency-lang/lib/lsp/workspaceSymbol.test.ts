import { describe, it, expect } from "vitest";
import { SymbolKind } from "vscode-languageserver-protocol";
import { getWorkspaceSymbols } from "./workspaceSymbol.js";
import { SymbolTable } from "../symbolTable.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("getWorkspaceSymbols", () => {
  it("returns symbols matching a query", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-ws-test-"));
    try {
      const file = path.join(tmpDir, "helpers.agency");
      fs.writeFileSync(file, "export def greet(name: string) {\n  return name\n}\nexport def goodbye() {\n  return 1\n}\n");
      const symbolTable = SymbolTable.build(file, {});
      const results = getWorkspaceSymbols("greet", symbolTable);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("greet");
      expect(results[0].kind).toBe(SymbolKind.Function);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns all symbols for empty query", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-ws-test-"));
    try {
      const file = path.join(tmpDir, "test.agency");
      fs.writeFileSync(file, "export def foo() { }\nexport def bar() { }\n");
      const symbolTable = SymbolTable.build(file, {});
      const results = getWorkspaceSymbols("", symbolTable);
      expect(results.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty for no matches", () => {
    const symbolTable = new SymbolTable();
    const results = getWorkspaceSymbols("nonexistent", symbolTable);
    expect(results).toHaveLength(0);
  });
});
