import { describe, it, expect } from "vitest";
import { PRELUDE_NAMES, preludeImportLine } from "./prelude.js";
import { SymbolTable } from "./symbolTable.js";
import { resolveAgencyImportPath } from "./importPaths.js";

describe("the prelude", () => {
  // Collapsing the parser template and the LSP onto one list stops those two
  // from disagreeing, but it can't stop the list from disagreeing with the
  // stdlib. Rename an export in stdlib/index.agency and the prelude would
  // still ask for the old name — breaking every Agency file at once. This
  // catches that at unit-test speed.
  it("only names things std::index actually exports", () => {
    const stdlibPath = resolveAgencyImportPath("std::index", process.cwd());
    const symbolTable = SymbolTable.build(stdlibPath, {});
    const symbols = symbolTable.getFile(stdlibPath);
    expect(symbols).toBeDefined();

    const exportedNames = Object.keys(symbols!).filter(
      (name) => symbols![name].exported,
    );
    const missing = PRELUDE_NAMES.filter((n) => !exportedNames.includes(n));
    expect(missing).toEqual([]);
  });

  // The prelude is deliberately a *subset* of what std::index exports:
  // setAgentCwd and friends are importable but intentionally not in scope
  // everywhere. So the check above runs in one direction only — this
  // records why, so nobody "fixes" it into a two-way equality check and
  // drags those names into every file.
  it("is a subset, not a mirror, of the std::index exports", () => {
    expect(PRELUDE_NAMES).not.toContain("setAgentCwd");
    expect(PRELUDE_NAMES).not.toContain("getAgentCwd");
    expect(PRELUDE_NAMES).not.toContain("applyAgentCwd");
  });

  // AGENCY_TEMPLATE_OFFSET (lib/parsers/parsers.ts) hardcodes how many lines
  // the parser template adds, and every diagnostic's line number is computed
  // by subtracting it. A prelude import that wrapped onto a second line
  // would silently shift every error in the editor down a row.
  it("renders as a single line", () => {
    expect(preludeImportLine()).not.toContain("\n");
  });
});
