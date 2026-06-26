import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SymbolTable } from "./symbolTable.js";

describe("SymbolTable.allEffectDeclarations", () => {
  it("collects effect declarations across the import closure", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eff-"));
    try {
      fs.writeFileSync(
        path.join(dir, "lib.agency"),
        "effect std::read { dir: string }\nexport def noop() { return 1 }\n",
      );
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { noop } from "./lib.agency"\n' +
          "effect deploy { service: string }\n" +
          'node main() { print("hi") }\n',
      );
      const st = SymbolTable.build(path.join(dir, "main.agency"));
      const effects = st
        .allEffectDeclarations()
        .map((d) => d.decl.effect)
        .sort();
      expect(effects).toEqual(["deploy", "std::read"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
