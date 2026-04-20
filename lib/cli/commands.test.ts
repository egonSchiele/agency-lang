import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, resetCompilationCache } from "./commands.js";

describe("compile output path extension replacement", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    resetCompilationCache();
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worksy.agency-init-"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetCompilationCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("only replaces the .agency file extension when compiling imported files", () => {
    const srcDir = path.join(tmpDir, "src", "agency", "lib");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, "src", "agency", "agent.agency"),
      'import { helper } from "./lib/research.agency"\nnode main() {}',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(srcDir, "research.agency"),
      "export def helper() {}",
      "utf-8",
    );

    process.chdir(tmpDir);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() =>
        compile({}, path.join("src", "agency", "agent.agency"), undefined, { ts: true }),
      ).not.toThrow();

      expect(fs.existsSync(path.join(tmpDir, "src", "agency", "agent.ts"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "src", "agency", "lib", "research.ts"))).toBe(true);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });
});
