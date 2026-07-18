import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _readSkill, _docsDir } from "./skills.js";
import { _glob } from "./shell.js";

describe("_readSkill", () => {
  let fakeHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-home-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("reads a skill at a ~/-prefixed path", () => {
    // The bug this guards against: pre-fix, `_readSkill("~/foo.md")`
    // resolved `~` as a literal directory name under the module dir,
    // producing `<moduleDir>/~/foo.md` and throwing ENOENT instead of
    // reading from the user's home.
    const skillDir = path.join(fakeHome, ".agency", "skills");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "test-skill.md");
    fs.writeFileSync(skillPath, "skill body");

    expect(_readSkill("~/.agency/skills/test-skill.md")).toBe("skill body");
  });

  it("reads a skill at `~` alone (file directly under home)", () => {
    const skillPath = path.join(fakeHome, "bare.md");
    fs.writeFileSync(skillPath, "bare body");

    // `_readSkill("~")` would refer to home directly — not a file. The
    // meaningful case is `~/<filename>` since skills are files. This
    // test covers the simplest valid tilde form.
    expect(_readSkill("~/bare.md")).toBe("bare body");
  });

  it("still resolves a relative path against the module dir (no regression)", () => {
    // Confirms the `expandPath` wrapper is a no-op on non-tilde paths.
    // Outside an Agency frame, getModuleDir() falls back to process.cwd().
    const cwd = process.cwd();
    const targetPath = path.join(cwd, "relative-skill.md");
    fs.writeFileSync(targetPath, "relative body");
    try {
      expect(_readSkill("relative-skill.md")).toBe("relative body");
    } finally {
      fs.rmSync(targetPath, { force: true });
    }
  });
});

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
    const flat = await _glob("*.{md,markdown}", stdlibDocs, 500, []);
    const recursive = await _glob("**/*.{md,markdown}", stdlibDocs, 500, []);
    expect(recursive.length).toBeGreaterThan(flat.length);
    expect(recursive).toContain("ui/table.md"); // nested
    expect(recursive).toContain("array.md"); // top-level still present
  });
});
