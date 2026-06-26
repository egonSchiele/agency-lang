import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SymbolTable } from "./symbolTable.js";

describe("SymbolTable.allEffectDeclarations", () => {
  it("collects body-scoped effect declarations (not just top-level)", () => {
    // The parser accepts `effect ...` inside function bodies via
    // `_bodyNodeParser`. Without a deep walk, those declarations would
    // silently never reach the ambient registry — and raise sites for
    // the effect would go unchecked.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eff-body-"));
    try {
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        "def f() {\n" +
          "  effect std::nested { dir: string }\n" +
          "  return 1\n" +
          "}\n" +
          'node main() { print("hi") }\n',
      );
      const st = SymbolTable.build(path.join(dir, "main.agency"));
      const effects = st
        .allEffectDeclarations()
        .map((d) => d.decl.effect);
      // Exact length too — guards against a deep-walk regression that
      // double-visits the same node (`toContain` alone would let that pass).
      expect(effects).toEqual(["std::nested"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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
