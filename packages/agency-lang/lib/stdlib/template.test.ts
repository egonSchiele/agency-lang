import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _loadTemplate,
  _loadTemplateFromString,
  _holesOf,
  _parseExpr,
  _parseStatements,
  _toSource,
} from "./template.js";

function withTemplate(source: string): { dir: string; filename: string } {
  const dir = mkdtempSync(join(tmpdir(), "tpl-"));
  writeFileSync(join(dir, "t.agency"), source, "utf-8");
  return { dir, filename: "t.agency" };
}

describe("fragment parsing", () => {
  it("parses a bare expression, which is not a valid program", () => {
    const code = _parseExpr("42");
    expect(code.kind).toBe("expr");
    expect(code.nodes).toHaveLength(1);
  });

  it("parses a call expression", () => {
    expect(_parseExpr("getPrompt()").kind).toBe("expr");
  });

  it("parses a binary expression", () => {
    expect(_parseExpr("a + b").kind).toBe("expr");
  });

  it("rejects a statement passed to parseExpr", () => {
    expect(() => _parseExpr("const x = 1")).toThrow();
  });

  it("parses a statement list", () => {
    const code = _parseStatements("const x = 1\nprint(x)");
    expect(code.kind).toBe("statements");
    expect(code.nodes.length).toBeGreaterThan(1);
  });

  it("round-trips a fragment through toSource", () => {
    expect(_toSource(_parseExpr("a + b")).trim()).toBe("a + b");
  });
});

describe("_loadTemplate / _holesOf", () => {
  it("lists holes in source order with sort, splice, and annotated type", () => {
    const { dir, filename } = withTemplate(
      `node main() {\n  #setup\n  const x = #value: number\n}\n`,
    );
    expect(_holesOf(_loadTemplate(dir, filename))).toEqual([
      { name: "setup", sort: "statements", splice: false, type: null },
      { name: "value", sort: "expr", splice: false, type: "number" },
    ]);
  });

  it("returns an empty list when there are none", () => {
    const { dir, filename } = withTemplate(`node main() {\n  return 1\n}\n`);
    expect(_holesOf(_loadTemplate(dir, filename))).toEqual([]);
  });

  it("lists a duplicated hole name once, first occurrence winning", () => {
    const code = _loadTemplateFromString(
      `node main() {\n  const a = #x: number\n  const b = #x\n}\n`,
    );
    expect(_holesOf(code)).toEqual([
      { name: "x", sort: "expr", splice: false, type: "number" },
    ]);
  });

  it("fails on a file that does not parse", () => {
    const { dir, filename } = withTemplate(`node {{{`);
    expect(() => _loadTemplate(dir, filename)).toThrow();
  });

  it("fails on a file that does not exist", () => {
    const { dir } = withTemplate(`node main() {\n  return 1\n}\n`);
    expect(() => _loadTemplate(dir, "missing.agency")).toThrow();
  });
});
