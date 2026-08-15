import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { getEffectsFromFile } from "../compiler/typecheck.js";
import { analyzeInterrupts } from "./interrupts.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

let dir: string;
beforeEach(() => {
  dir = makeAgencyTempDir("effectsoracle");
});
afterEach(() => {
  safeDeleteDirectory(dir, false);
});

function symbolTableEffects(entry: string, name: string): string[] {
  const table = SymbolTable.build(entry, {});
  const sym = table.getFile(path.resolve(entry))?.[name];
  return sym && (sym.kind === "function" || sym.kind === "node")
    ? (sym.interruptEffects ?? []).map((entry) => entry.effect).sort()
    : [];
}

/**
 * Cases where BOTH sides compute the answer themselves: the effect arises
 * inside the file under test, so the type checker propagates through its own
 * scopes rather than reading the symbol table's answer back out.
 *
 * Comparing against getEffectsFromFile for an IMPORTED function would prove
 * nothing — that path seeds imported effects from sym.interruptEffects, so it
 * reads back what the new pass just wrote.
 */
describe("the two analyses agree on effects that arise in one file", () => {
  const cases: { label: string; source: string }[] = [
    {
      label: "a local helper reached by a plain call",
      source: `export def helper(): string {\n  return read("x")\n}\nexport def caller(): string {\n  return helper()\n}\n`,
    },
    {
      label: "a helper called inside a loop",
      source: `export def helper(): string {\n  return read("x")\n}\nexport def caller(): string {\n  for (i in [1, 2]) {\n    helper()\n  }\n  return "done"\n}\n`,
    },
    {
      label: "a guard block in the same file",
      source: `export def caller(): string {\n  const r = guard(cost: $0.50) {\n    return "hi"\n  }\n  return "done"\n}\n`,
    },
    {
      label: "a two-hop local chain",
      source: `export def inner(): string {\n  return read("x")\n}\nexport def middle(): string {\n  return inner()\n}\nexport def caller(): string {\n  return middle()\n}\n`,
    },
  ];

  for (const { label, source } of cases) {
    it(`agrees on ${label}`, () => {
      const entry = path.join(dir, "main.agency");
      fs.writeFileSync(entry, source, "utf-8");
      const fromTypeChecker = (getEffectsFromFile(entry)["caller"] ?? []).sort();
      expect(symbolTableEffects(entry, "caller")).toEqual(fromTypeChecker);
      // Without this, the comparison passes when both sides found nothing.
      expect(fromTypeChecker.length).toBeGreaterThan(0);
    });
  }
});

describe("the new pass agrees with the type-check-everything analysis", () => {
  it("finds the same effect across a file boundary", () => {
    fs.writeFileSync(
      path.join(dir, "helper.agency"),
      `export def h(): string {\n  return read("data.txt")\n}\n`,
      "utf-8",
    );
    const main = path.join(dir, "main.agency");
    fs.writeFileSync(
      main,
      `import { h } from "./helper.agency"\nnode main() {\n  const x = h()\n}\n`,
      "utf-8",
    );

    // analyzeInterrupts type-checks each reachable file separately and never
    // reads sym.interruptEffects for its call edges, so this is a real second
    // opinion rather than a round trip.
    const sites = analyzeInterrupts(main, {}).sites.map((result) => result.site.effect);
    expect(sites).toContain("std::read");
    expect(symbolTableEffects(main, "main")).toEqual(["std::read"]);
  });
});
