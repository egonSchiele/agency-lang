import { describe, it, expect } from "vitest";
import { exportFromStatementParser } from "./parsers.js";

describe("exportFromStatementParser", () => {
  it("parses a simple named re-export", () => {
    const result = exportFromStatementParser(
      'export { foo } from "./tools.agency"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "exportFromStatement",
      modulePath: "./tools.agency",
      isAgencyImport: true,
      body: {
        kind: "namedExport",
        names: ["foo"],
        aliases: {},
        safeNames: [],
      },
    });
  });

  it("parses an aliased re-export", () => {
    const result = exportFromStatementParser(
      'export { search as wikipediaSearch } from "std::wikipedia"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.body).toEqual({
      kind: "namedExport",
      names: ["search"],
      aliases: { search: "wikipediaSearch" },
      safeNames: [],
    });
    expect(result.result.modulePath).toBe("std::wikipedia");
    expect(result.result.isAgencyImport).toBe(true);
  });

  it("parses multiple names with mixed aliasing", () => {
    const result = exportFromStatementParser(
      'export { search as wikipediaSearch, fetch } from "std::wikipedia"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.body).toEqual({
      kind: "namedExport",
      names: ["search", "fetch"],
      aliases: { search: "wikipediaSearch" },
      safeNames: [],
    });
  });

  it("parses per-name `safe` modifier", () => {
    const result = exportFromStatementParser(
      'export { safe search, fetch } from "std::wikipedia"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.body).toEqual({
      kind: "namedExport",
      names: ["search", "fetch"],
      aliases: {},
      safeNames: ["search"],
    });
  });

  it("parses safe with alias", () => {
    const result = exportFromStatementParser(
      'export { safe search as wikiSearch } from "std::wikipedia"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.body).toEqual({
      kind: "namedExport",
      names: ["search"],
      aliases: { search: "wikiSearch" },
      safeNames: ["search"],
    });
  });

  it("parses a star re-export", () => {
    const result = exportFromStatementParser(
      'export * from "std::wikipedia"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "exportFromStatement",
      modulePath: "std::wikipedia",
      isAgencyImport: true,
      body: { kind: "starExport" },
    });
  });

  it("rejects malformed export-from (missing from)", () => {
    const result = exportFromStatementParser(
      'export { foo } "./x.agency"',
    );
    expect(result.success).toBe(false);
  });

  it("rejects malformed export-from (missing braces)", () => {
    const result = exportFromStatementParser(
      'export foo from "./x.agency"',
    );
    expect(result.success).toBe(false);
  });
});
