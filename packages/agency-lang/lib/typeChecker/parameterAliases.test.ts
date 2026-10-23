import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

/** Type-check `source` as `main.agency` inside a fresh directory that also
 *  holds the given sibling files, so a test can import from another module. */
function errorsFrom(
  source: string,
  siblings: Record<string, string> = {},
  options: Record<string, unknown> = {},
): TypeCheckError[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tc-aliases-"));
  try {
    for (const [name, text] of Object.entries(siblings)) {
      writeFileSync(path.join(dir, name), text);
    }
    const file = path.join(dir, "main.agency");
    writeFileSync(file, source);
    const symbolTable = SymbolTable.build(file);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed: " + parseResult.message);
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, file, source);
    const { errors } = typeCheck(program, options, info);
    return errors.filter((e) => e.severity !== "warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (errors: TypeCheckError[]) => errors.map((e) => e.code);

describe("parameter aliases in the type checker", () => {
  describe("AG2022: names and aliases in one signature are distinct", () => {
    it("reports an alias that equals another parameter's name", () => {
      const errors = errorsFrom(`
        def f(a | b: string, b: string): string { return a }
      `);
      expect(codes(errors)).toContain("AG2022");
      expect(errors[0].message).toContain("alias 'b'");
      expect(errors[0].message).toContain("parameter 'b'");
    });

    it("reports an alias that equals another parameter's alias", () => {
      const errors = errorsFrom(`
        def f(a | x: string, b | x: string): string { return a }
      `);
      expect(codes(errors)).toEqual(["AG2022"]);
      expect(errors[0].message).toContain("Parameter 'b'");
      expect(errors[0].message).toContain("parameter 'a'");
    });

    it("reports an alias that repeats its own parameter's name", () => {
      const errors = errorsFrom(`
        def f(a | a: string): string { return a }
      `);
      expect(codes(errors)).toEqual(["AG2022"]);
    });

    it("reports two aliases on one parameter that repeat each other", () => {
      const errors = errorsFrom(`
        def f(a | b | b: string): string { return a }
      `);
      expect(codes(errors)).toEqual(["AG2022"]);
    });

    it("says nothing about a clean signature with three aliases", () => {
      const errors = errorsFrom(`
        def f(a | b | c | d: string, e | g: string): string { return a }
      `);
      expect(errors).toEqual([]);
    });
  });

  describe("AG6042: Agency code uses the parameter's name", () => {
    const fetchDef = `
      def fetch(baseUrl | url: string, path: string = "/"): string { return baseUrl + path }
    `;

    it("reports a call that uses an alias, naming the parameter", () => {
      const errors = errorsFrom(`
        ${fetchDef}
        node main() { fetch(url: "https://a") }
      `);
      expect(codes(errors)).toEqual(["AG6042"]);
      expect(errors[0].message).toBe(
        "'url' is an alias of parameter 'baseUrl' of 'fetch'. In Agency code, use 'baseUrl'.",
      );
    });

    it("accepts the canonical name", () => {
      const errors = errorsFrom(`
        ${fetchDef}
        node main() { fetch(baseUrl: "https://a") }
      `);
      expect(errors).toEqual([]);
    });

    it("reports an alias used on a function imported from another module", () => {
      const errors = errorsFrom(
        `
        import { fetch } from "./http.agency"
        node main() { fetch(url: "https://a") }
        `,
        { "http.agency": `export ${fetchDef.trim()}` },
      );
      expect(codes(errors)).toEqual(["AG6042"]);
    });

    it("reports an alias in a .partial() binding", () => {
      const errors = errorsFrom(`
        ${fetchDef}
        node main() { const f = fetch.partial(url: "https://a") }
      `);
      expect(codes(errors)).toEqual(["AG6042"]);
    });

    it("does not list the alias among the valid names for a different typo", () => {
      const errors = errorsFrom(`
        ${fetchDef}
        node main() { fetch(baseURL: "https://a") }
      `);
      expect(codes(errors)).toEqual(["AG6025"]);
      expect(errors[0].message).toContain("baseUrl");
      expect(errors[0].message).not.toContain("url,");
      expect(errors[0].message).not.toMatch(/\burl\b/);
    });
  });

  describe("rule 1: the body sees one name", () => {
    it("treats an alias used in the body as an undefined variable", () => {
      const errors = errorsFrom(
        `
        def f(a | b: string): string { return b }
        `,
        {},
        { typechecker: { undefinedVariables: "error" } },
      );
      expect(errors.some((e) => /\bb\b/.test(e.message))).toBe(true);
    });

    it("binds the canonical name", () => {
      const errors = errorsFrom(
        `
        def f(a | b: string): string { return a }
        `,
        {},
        { typechecker: { undefinedVariables: "error" } },
      );
      expect(errors).toEqual([]);
    });
  });
});
