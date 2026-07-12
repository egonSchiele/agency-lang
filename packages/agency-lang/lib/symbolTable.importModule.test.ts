import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SymbolTable } from "./symbolTable.js";

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-immod-"));
  for (const [name, src] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), src);
  }
  return dir;
}

describe("SymbolTable.resolveImportModule", () => {
  it("returns loaded with symbols for a crawled Agency file", () => {
    const dir = makeDir({
      "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
      "use.agency": 'import { realFn } from "./lib.agency"\n\nnode u(): string {\n  return realFn()\n}\n',
    });
    const usePath = path.join(dir, "use.agency");
    const table = SymbolTable.build(usePath);
    const result = table.resolveImportModule("./lib.agency", usePath);
    expect(result.kind).toBe("loaded");
    if (result.kind === "loaded") {
      expect(Object.prototype.hasOwnProperty.call(result.symbols, "realFn")).toBe(true);
    }
  });

  it("returns missing for a module path that does not exist", () => {
    const dir = makeDir({
      "use.agency": 'import { x } from "./ghost.agency"\n\nnode u(): string {\n  return "y"\n}\n',
    });
    const usePath = path.join(dir, "use.agency");
    const table = SymbolTable.build(usePath);
    expect(table.resolveImportModule("./ghost.agency", usePath).kind).toBe("missing");
  });

  it("returns notLoaded for a file that exists on disk but was never crawled", () => {
    const dir = makeDir({
      "use.agency": 'node u(): string {\n  return "y"\n}\n',
      "other.agency": "export def helper(): string {\n  return \"h\"\n}\n",
    });
    const usePath = path.join(dir, "use.agency");
    // build seeded from use.agency, which imports nothing → other.agency is
    // never loaded, though it exists on disk.
    const table = SymbolTable.build(usePath);
    expect(table.resolveImportModule("./other.agency", usePath).kind).toBe("notLoaded");
  });

  it("returns missing when path resolution throws (unresolvable pkg::)", () => {
    const dir = makeDir({
      "use.agency": 'node u(): string {\n  return "y"\n}\n',
    });
    const usePath = path.join(dir, "use.agency");
    const table = SymbolTable.build(usePath);
    expect(table.resolveImportModule("pkg::@no/such-package", usePath).kind).toBe("missing");
  });
});
