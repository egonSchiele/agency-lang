import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "../symbolTable.js";
import { typeCheck, formatErrors } from "./index.js";
import fs from "fs";
import path from "path";

/**
 * Discovers all .agency files recursively in a directory.
 */
function discoverAgencyFiles(fixtureDir: string): { name: string; filePath: string }[] {
  const files: { name: string; filePath: string }[] = [];

  function scanDirectory(dir: string, relativePath: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        scanDirectory(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".agency")) {
        const baseName = entry.name.replace(".agency", "");
        const nameWithoutExt = relativePath
          ? `${relativePath}/${baseName}`
          : baseName;
        files.push({ name: nameWithoutExt, filePath: fullPath });
      }
    }
  }

  scanDirectory(fixtureDir);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

const FIXTURES_DIR = path.resolve(__dirname, "../../tests/typescriptGenerator");
const STDLIB_DIR = path.resolve(__dirname, "../../stdlib");

// Fixtures that intentionally contain type errors (e.g. testing runtime validation)
const SKIP_TYPECHECK = new Set([
  "bangParams",         // intentionally passes wrong type to test bang (!) validation
  "functionRef",        // typechecker doesn't yet support function-ref assignability to function types
  "euler/euler-0004",   // uses string.length which typechecker doesn't recognize yet
  "euler/euler-0008",   // uses string.length which typechecker doesn't recognize yet
  "blockParams",        // calls append() which doesn't exist (should use .push())
  "ifElse",             // calls undefined isReady(), uses undeclared variables
  "setLLMClient",       // setLLMClient() is runtime-injected, not visible to typechecker
]);

// Stdlib files with known warnings from typechecker limitations
const SKIP_STDLIB = new Set([
  "index",     // shadows warnings are expected (index.agency re-exports builtins)
  "strategy",  // uses fork which is a language primitive, not a function
  "agency",    // unhandled interrupt warning for run()
  "object",    // uses object methods the typechecker doesn't resolve yet
]);

function assertNoTypeErrors(name: string, filePath: string) {
  const contents = fs.readFileSync(filePath, "utf-8");
  const absPath = path.resolve(filePath);

  // 1. Parse (with template, like the CLI tc command does)
  const parseResult = parseAgency(contents);
  if (!parseResult.success) {
    throw new Error(
      `Failed to parse: ${name}\nFile: ${filePath}\nError: ${parseResult.message}`
    );
  }

  // 2. Build symbol table and compilation unit (resolves imports including stdlib)
  const symbolTable = SymbolTable.build(absPath);
  const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, contents);

  // 3. Typecheck
  const { errors } = typeCheck(parseResult.result, {}, info);

  // 4. Fail on any errors or warnings
  if (errors.length > 0) {
    const formatted = formatErrors(errors);
    throw new Error(
      `Type errors/warnings in: ${name}\nFile: ${filePath}\n${formatted}`
    );
  }
}

describe("Typechecker Integration Tests (fixtures)", () => {
  const fixtures = discoverAgencyFiles(FIXTURES_DIR)
    .filter((f) => !SKIP_TYPECHECK.has(f.name));

  if (fixtures.length === 0) {
    it("should find test fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, filePath }) => {
      it("should have no type errors or warnings", () => {
        assertNoTypeErrors(name, filePath);
      });
    }
  );
});

describe("Typechecker Integration Tests (stdlib)", () => {
  const stdlibFiles = discoverAgencyFiles(STDLIB_DIR)
    .filter((f) => !SKIP_STDLIB.has(f.name));

  if (stdlibFiles.length === 0) {
    it("should find stdlib files", () => {
      expect(stdlibFiles.length).toBeGreaterThan(0);
    });
  }

  describe.each(stdlibFiles)(
    "stdlib: $name",
    ({ name, filePath }) => {
      it("should have no type errors or warnings", () => {
        assertNoTypeErrors(name, filePath);
      });
    }
  );
});
