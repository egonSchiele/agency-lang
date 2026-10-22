import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { getCapabilitiesFromFile, getEffectsFromFile } from "../compiler/typecheck.js";
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
    {
      // The decorator lowers to a call in the TypeChecker constructor; the
      // symbol table reads the tag instead. Both must land on std::read.
      label: "a decorator whose body raises",
      source: `export def deco(block: () -> any): any {\n  read("x")\n  return block()\n}\n@deco\nexport def caller(): string {\n  return "y"\n}\n`,
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

  it("finds the effect of a decorator imported from another file", () => {
    fs.writeFileSync(
      path.join(dir, "deco.agency"),
      `export def logged(block: () -> any): any {\n  read("log.txt")\n  return block()\n}\n`,
      "utf-8",
    );
    const main = path.join(dir, "main.agency");
    fs.writeFileSync(
      main,
      `import { logged } from "./deco.agency"\n@logged\nexport def caller(): string {\n  return "y"\n}\n`,
      "utf-8",
    );
    expect(symbolTableEffects(main, "caller")).toEqual(["std::read"]);
    expect((getEffectsFromFile(main)["caller"] ?? []).sort()).toEqual(["std::read"]);
  });
});

/** The symbol table's answer for what `name` needs from the host, after the
 *  capabilities view of the propagation pass has run. */
function symbolTableCapabilities(entry: string, name: string): string[] {
  const table = SymbolTable.build(entry, {});
  const sym = table.getFile(path.resolve(entry))?.[name];
  return sym && (sym.kind === "function" || sym.kind === "node")
    ? [...(sym.capabilities ?? [])].sort()
    : [];
}

/**
 * The capabilities view runs over the same call edges as the effect views,
 * and the type checker runs its own walk over its scopes. The two must agree
 * on what a function needs when the need arises inside the file under test.
 */
describe("the two analyses agree on capabilities that arise in one file", () => {
  const cases: { label: string; source: string }[] = [
    {
      label: "a tagged helper reached by a plain call",
      source: `@capabilities(network)\nexport def helper(): string {\n  return "x"\n}\nexport def caller(): string {\n  return helper()\n}\n`,
    },
    {
      label: "a two-hop local chain to a tagged function",
      source: `@capabilities(subprocess, env)\nexport def inner(): string {\n  return "x"\n}\nexport def middle(): string {\n  return inner()\n}\nexport def caller(): string {\n  return middle()\n}\n`,
    },
    {
      label: "a tag on the caller itself joined with one it reaches",
      source: `@capabilities(network)\nexport def helper(): string {\n  return "x"\n}\n@capabilities(terminal)\nexport def caller(): string {\n  return helper()\n}\n`,
    },
  ];

  for (const { label, source } of cases) {
    it(`agrees on ${label}`, () => {
      const entry = path.join(dir, "main.agency");
      fs.writeFileSync(entry, source, "utf-8");
      const fromTypeChecker = getCapabilitiesFromFile(entry)["caller"] ?? [];
      expect(symbolTableCapabilities(entry, "caller")).toEqual(fromTypeChecker);
      expect(fromTypeChecker.length).toBeGreaterThan(0);
    });
  }

  it("carries a need across a file boundary", () => {
    fs.writeFileSync(
      path.join(dir, "helper.agency"),
      `@capabilities(network)\nexport def h(): string {\n  return "x"\n}\n`,
      "utf-8",
    );
    const main = path.join(dir, "main.agency");
    fs.writeFileSync(
      main,
      `import { h } from "./helper.agency"\nexport def caller(): string {\n  return h()\n}\n`,
      "utf-8",
    );
    expect(symbolTableCapabilities(main, "caller")).toEqual(["network"]);
    expect(getCapabilitiesFromFile(main)["caller"]).toEqual(["network"]);
  });
});
