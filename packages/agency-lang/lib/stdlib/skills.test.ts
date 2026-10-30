import { describe, it, expect } from "vitest";
import path from "node:path";
import { _docsDir, _parseSkillFile, _refusedSkillName } from "./skills.js";
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

describe("_refusedSkillName", () => {
  const refused = [
    "a\u0007b",
    "a\u200Bb",
    "a\u202Eb",
    "bad<name>",
    "a>b",
    " lead",
    "trail ",
    "two  spaces",
    "synced",
    "anthropic-skills",
    "anthropic-skills:demo",
  ];
  for (const name of refused) {
    it(`refuses ${JSON.stringify(name)}`, () => {
      expect(_refusedSkillName(name)).toBe(true);
    });
  }

  for (const name of ["review-pr", "My Skill", "anthropic-skillset"]) {
    it(`allows ${JSON.stringify(name)}`, () => {
      expect(_refusedSkillName(name)).toBe(false);
    });
  }
});

describe("_parseSkillFile", () => {
  it("reads flat keys and strips matching quotes", () => {
    const parsed = _parseSkillFile(
      "---\nname: deploy\ndescription: \"Ship it.\"\nhint: 'x'\n---\nBody.\n",
    );
    expect(parsed.data).toEqual({ name: "deploy", description: "Ship it.", hint: "x" });
    expect(parsed.body).toBe("Body.");
  });

  it("keeps reading top-level keys after a block list, a comment, and a blank line", () => {
    const raw = [
      "---",
      "description: Deploy.",
      "allowed-tools:",
      "  - Bash",
      "# a comment",
      "",
      "disable-model-invocation: true",
      "---",
      "Body.",
    ].join("\n");
    expect(_parseSkillFile(raw).data).toEqual({
      description: "Deploy.",
      "allowed-tools": "",
      "disable-model-invocation": "true",
    });
  });

  it("folds a > block and keeps the lines of a | block", () => {
    const raw = "---\nfolded: >\n  one\n  two\nliteral: |\n  one\n  two\n---\n";
    expect(_parseSkillFile(raw).data).toEqual({ folded: "one two", literal: "one\ntwo" });
  });

  it("reads a file with Windows line endings", () => {
    const parsed = _parseSkillFile("---\r\nname: deploy\r\n---\r\nBody.\r\n");
    expect(parsed.data).toEqual({ name: "deploy" });
    expect(parsed.body).toBe("Body.");
  });

  it("keeps every value a string", () => {
    expect(_parseSkillFile("---\nname: 2024\nflag: true\n---\n").data).toEqual({
      name: "2024",
      flag: "true",
    });
  });

  it("treats a file with no frontmatter, or an unclosed fence, as all body", () => {
    expect(_parseSkillFile("Bare body.\n")).toEqual({ data: {}, body: "Bare body." });
    expect(_parseSkillFile("---\nname: x\n")).toEqual({ data: {}, body: "---\nname: x" });
  });
});
