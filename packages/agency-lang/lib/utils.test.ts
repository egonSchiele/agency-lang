import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { safeDeleteFile, safeDeleteDirectory } from "./utils.js";
import { findPackageRoot } from "./importPaths.js";

// All tests here use dryRun=true (the default). We never exercise the
// real-delete path: a regression that swept past the containment check
// could otherwise erase real files.
describe("safeDeleteFile / safeDeleteDirectory (dry-run only)", () => {
  const projectRoot = realpathSync(findPackageRoot(__dirname));
  // A scratch directory inside the project so containment passes.
  let scratch: string;
  let insideFile: string;
  let insideDir: string;
  // A directory outside the project (in os.tmpdir) for negative tests.
  let outsideDir: string;
  let outsideFile: string;

  beforeAll(() => {
    scratch = join(projectRoot, ".test-safe-delete-scratch");
    mkdirSync(scratch, { recursive: true });
    insideFile = join(scratch, "inside.txt");
    writeFileSync(insideFile, "hello");
    insideDir = join(scratch, "subdir");
    mkdirSync(insideDir, { recursive: true });
    writeFileSync(join(insideDir, "nested.txt"), "nested");

    outsideDir = mkdtempSync(join(tmpdir(), "safe-delete-outside-"));
    outsideFile = join(outsideDir, "outside.txt");
    writeFileSync(outsideFile, "outside");
  });

  afterAll(() => {
    // Clean up scratch areas using a direct rm — these tests created them,
    // they're not testing rm.
    rmSync(scratch, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  describe("safeDeleteFile", () => {
    it("returns success with [DRY RUN] message for a real file inside the project", () => {
      const result = safeDeleteFile(insideFile);
      expect(result.success).toBe(true);
      expect(result.message).toBe(
        `[DRY RUN]: would have deleted ${realpathSync(insideFile)}`,
      );
      // File still exists — we were in dry-run.
      expect(existsSync(insideFile)).toBe(true);
    });

    it("refuses a directory (not a file)", () => {
      const result = safeDeleteFile(insideDir);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Not a file/);
    });

    it("refuses a missing path", () => {
      const result = safeDeleteFile(join(scratch, "does-not-exist.txt"));
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/does not exist/);
    });

    it("refuses a file outside the project", () => {
      const result = safeDeleteFile(outsideFile);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/outside project root|no project root found/);
    });

    it("refuses a symlink whose realpath escapes the project", () => {
      const symlinkPath = join(scratch, "escape-link.txt");
      symlinkSync(outsideFile, symlinkPath);
      const result = safeDeleteFile(symlinkPath);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/outside project root|no project root found/);
      rmSync(symlinkPath, { force: true });
    });
  });

  describe("safeDeleteDirectory", () => {
    it("returns success with [DRY RUN] message for a real directory inside the project", () => {
      const result = safeDeleteDirectory(insideDir);
      expect(result.success).toBe(true);
      expect(result.message).toBe(
        `[DRY RUN]: would have deleted ${realpathSync(insideDir)}`,
      );
      // Directory still exists — we were in dry-run.
      expect(existsSync(insideDir)).toBe(true);
    });

    it("refuses a file (not a directory)", () => {
      const result = safeDeleteDirectory(insideFile);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Not a directory/);
    });

    it("refuses a missing path", () => {
      const result = safeDeleteDirectory(join(scratch, "no-such-dir"));
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/does not exist/);
    });

    it("refuses a directory outside the project", () => {
      const result = safeDeleteDirectory(outsideDir);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/outside project root|no project root found/);
    });

    it("refuses a symlinked directory whose realpath escapes the project", () => {
      const symlinkPath = join(scratch, "escape-link-dir");
      symlinkSync(outsideDir, symlinkPath);
      const result = safeDeleteDirectory(symlinkPath);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/outside project root|no project root found/);
      rmSync(symlinkPath, { force: true, recursive: true });
    });
  });
});
