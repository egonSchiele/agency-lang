import { describe, it, expect } from "vitest";
import path from "node:path";
import { _docsDir } from "./skills.js";
import { _glob } from "./shell.js";

describe("_docsDir", () => {
  it("resolves the diagnostics section under docs/", () => {
    // Guards the union widening ("guide" | "cli" | "diagnostics"). Pure path
    // math — does not depend on the staged docs being present.
    expect(_docsDir("diagnostics").endsWith(path.join("docs", "diagnostics"))).toBe(true);
  });

  it("resolves the stdlib section under docs/", () => {
    expect(_docsDir("stdlib").endsWith(path.join("docs", "stdlib"))).toBe(true);
  });
});

describe("stdlib docs recursive glob", () => {
  // The stdlib docs tree has nested modules (ui/table.md, auth/oauth.md, …).
  // A non-recursive `*.{md,markdown}` drops them; `**/*.{md,markdown}` must not.
  const stdlibDocs = path.resolve(__dirname, "../../docs/site/stdlib");

  it("includes nested modules that the flat pattern misses", async () => {
    const flat = await _glob(stdlibDocs, ".", "*.{md,markdown}", 500);
    const recursive = await _glob(stdlibDocs, ".", "**/*.{md,markdown}", 500);
    expect(recursive.length).toBeGreaterThan(flat.length);
    expect(recursive).toContain("ui/table.md"); // nested
    expect(recursive).toContain("array.md"); // top-level still present
  });

  it("is a no-op for the flat sections (guide has no nested pages)", async () => {
    // docsSkill now always globs recursively. guide/cli/diagnostics have no
    // nested docs, so recursion must list exactly the same pages as the flat
    // pattern — a regression here would silently drop pages from those tools.
    const guideDocs = path.resolve(__dirname, "../../docs/site/guide");
    const flat = await _glob(guideDocs, ".", "*.{md,markdown}", 500);
    const recursive = await _glob(guideDocs, ".", "**/*.{md,markdown}", 500);
    expect(recursive.length).toBeGreaterThan(0);
    expect(recursive.sort()).toEqual(flat.sort());
  });
});
