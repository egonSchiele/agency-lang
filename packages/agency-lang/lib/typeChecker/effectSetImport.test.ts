import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function typecheckImporter(files: Record<string, string>, entry: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-imp-"));
  for (const [name, src] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), src);
  }
  const entryPath = path.join(dir, entry);
  const src = files[entry];
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(`parse failed: ${(parsed as { message?: string }).message}`);
  const symbols = SymbolTable.build(entryPath);
  const info = buildCompilationUnit(parsed.result, symbols, entryPath, src);
  return typeCheck(parsed.result, {}, info).errors;
}

describe("cross-module effectSet import", () => {
  it("resolves and enforces an imported effect set", () => {
    const errors = typecheckImporter(
      {
        "lib.agency": "export effectSet FsKinds = <std::read>\n",
        "main.agency":
          'import { FsKinds } from "./lib.agency"\n' +
          'def f(): number raises FsKinds { raise std::write("m", {})\n return 1 }\n',
      },
      "main.agency",
    );
    // std::write is not in the imported FsKinds (<std::read>) → error
    expect(errors.find((e) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("accepts an inferred effect that IS in the imported set", () => {
    const errors = typecheckImporter(
      {
        "lib.agency": "export effectSet FsKinds = <std::read>\n",
        "main.agency":
          'import { FsKinds } from "./lib.agency"\n' +
          'def f(): number raises FsKinds { raise std::read("m", {})\n return 1 }\n',
      },
      "main.agency",
    );
    expect(errors.filter((e) => /raises effect|not an effect set/.test(e.message))).toHaveLength(0);
  });
});
