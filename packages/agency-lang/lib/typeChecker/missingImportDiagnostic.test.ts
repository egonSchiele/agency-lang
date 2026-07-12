import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(files: Record<string, string>, entry: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-miss-"));
  try {
    for (const [name, src] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), src);
    }
    const entryPath = path.join(dir, entry);
    const src = files[entry];
    const parsed = parseAgency(src);
    if (!parsed.success) {
      throw new Error(`parse failed: ${(parsed as { message?: string }).message}`);
    }
    const symbols = SymbolTable.build(entryPath);
    const info = buildCompilationUnit(parsed.result, symbols, entryPath, src);
    return typeCheck(parsed.result, {}, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("checkMissingImports", () => {
  it("errors on a name the target file does not define", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import { missingFn } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    const e = errors.find((err) => err.name === "importNameNotFound");
    expect(e).toBeDefined();
    expect(e?.message).toContain("missingFn");
  });

  it("names the original name for an aliased import", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import { missingFn as m } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    const e = errors.find((err) => err.name === "importNameNotFound");
    expect(e?.message).toContain("missingFn");
  });

  it("errors on a missing node import", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import node { ghostNode } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeDefined();
  });

  it("errors on a module path that does not exist", () => {
    const errors = check(
      {
        "use.agency": 'import { x } from "./ghost.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    const e = errors.find((err) => err.name === "importModuleNotFound");
    expect(e).toBeDefined();
    expect(e?.message).toContain("./ghost.agency");
  });

  it("stays silent when the target exists but failed to load (parse error)", () => {
    // This test depends on `broken.agency` failing to parse, so `build` skips
    // it and `getFile` returns undefined → `notLoaded` → silent. The dependency
    // is on the parser: if the parser ever accepts this body, the target would
    // load and the test would turn RED (name absent → error), not falsely green.
    // So the coupling is safe — it can only over-report, never miss a real bug.
    const errors = check(
      {
        "broken.agency": "def def def { { { <<< not valid agency\n",
        "use.agency": 'import { anything } from "./broken.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("accepts a real cross-file import", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import { realFn } from "./lib.agency"\n\nnode u(): string {\n  return realFn()\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("ignores JavaScript imports", () => {
    // The `if (!node.isAgencyImport)` guard is load-bearing: the checker can't
    // read a .js file's exports. Remove the guard and this .js import gets flagged.
    const errors = check(
      {
        "use.agency": 'import { anything } from "./helper.js"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("accepts a valid node import", () => {
    // Positive counterpart to the missing-node test: guards that nodes are
    // looked up in the right place (FileSymbols keyed by node name).
    const errors = check(
      {
        "lib.agency": "export node helperNode(): string {\n  return \"n\"\n}\n",
        "use.agency": 'import node { helperNode } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("reports only the missing name in a mixed import", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import { realFn, missingFn } from "./lib.agency"\n\nnode u(): string {\n  return realFn()\n}\n',
      },
      "use.agency",
    );
    const nameErrors = errors.filter((err) => err.name === "importNameNotFound");
    expect(nameErrors).toHaveLength(1);
    expect(nameErrors[0].message).toContain("missingFn");
    expect(nameErrors[0].message).not.toContain("realFn");
  });

  it("reports exactly one module error for a multi-name missing module", () => {
    const errors = check(
      {
        "use.agency": 'import { a, b } from "./ghost.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.filter((err) => err.name === "importModuleNotFound")).toHaveLength(1);
  });

  it("accepts an import of a re-exported name", () => {
    // Relies on mergeExportsFrom merging `deep` into barrel.agency's FileSymbols
    // during build. A regression in the merge would false-positive here.
    const errors = check(
      {
        "real.agency": "export def deep(): string {\n  return \"d\"\n}\n",
        "barrel.agency": 'export { deep } from "./real.agency"\n',
        "use.agency": 'import { deep } from "./barrel.agency"\n\nnode u(): string {\n  return deep()\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("accepts a valid std:: import", () => {
    // std:: resolves through a different branch of resolveAgencyImportPath.
    // `bash` is a real export of std::shell (verified). We only assert the
    // absence of import diagnostics, so any unrelated marker warning is ignored.
    const errors = check(
      {
        "use.agency": 'import { bash } from "std::shell"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });
});
