import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SymbolTable } from "./symbolTable.js";
import { describeDiagnostic, prepareProgram } from "./compiler/prepareProgram.js";
import { typeCheck } from "./typeChecker/index.js";
import { safeDeleteDirectoryWithin } from "./utils.js";
import type { DiagnosticName } from "./typeChecker/diagnostics.js";

// `agency compile` prints type errors and still exits 0, so a stdlib
// function that starts raising an effect its `raises` clause does not list
// would pass the build. This test is what fails CI in that case.

const RAISES_DIAGNOSTICS: DiagnosticName[] = [
  "raisesNotAnEffectSet",
  "raisesExceeded",
  "raisesExceededViaDecorator",
  "valueMayRaiseAnyEffect",
  "valueEffectExceedsRaises",
];

function agencyFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return agencyFilesUnder(full);
    }
    return entry.name.endsWith(".agency") ? [full] : [];
  });
}

/** The `raises` errors in each file, as "file:line message" lines. Uses the
 *  pipeline `agency typecheck` uses: one symbol table for every file, then
 *  prepareProgram and the checker per file. */
function raisesErrorsIn(files: string[]): string[] {
  const table = SymbolTable.build(files, {});
  return files.flatMap((file) => {
    const prepared = prepareProgram(
      fs.readFileSync(file, "utf8"),
      file,
      {},
      {
        symbolTable: table,
        keepGoing: true,
        allowTestImports: true,
      },
    );
    if (!prepared.ok) {
      return [
        `${file}: did not prepare: ${prepared.diagnostics.map((found) => describeDiagnostic(found, file)).join("; ")}`,
      ];
    }
    return typeCheck(prepared.program, {}, prepared.info)
      .errors.filter((error) => RAISES_DIAGNOSTICS.includes(error.name))
      .map(
        (error) =>
          `${path.relative(process.cwd(), file)}:${error.loc?.line ?? "?"} ${error.message}`,
      );
  });
}

describe("stdlib raises clauses", () => {
  it("reports a clause that leaves out an effect", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-raises-"));
    try {
      const file = path.join(dir, "main.agency");
      fs.writeFileSync(
        file,
        `export def readIt(filename: string): Result raises <std::write> {\n  return read(filename)\n}\n`,
      );
      expect(raisesErrorsIn([file]).join("\n")).toContain("std::read");
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), dir);
    }
  });

  it("every clause in the stdlib lists every effect its function raises", () => {
    const files = agencyFilesUnder(path.join(process.cwd(), "stdlib"));
    expect(files.length).toBeGreaterThan(50);
    expect(raisesErrorsIn(files)).toEqual([]);
  }, 300_000);
});
