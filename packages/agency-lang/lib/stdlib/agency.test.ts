import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _compileFile } from "./agency.js";

describe("_compileFile sandbox containment", () => {
  let sandbox: string;
  let outsideFile: string;

  beforeAll(() => {
    // Layout:
    //   <tmp>/
    //     sandbox-XXXX/
    //       inside.agency      <- legal target
    //     outside.agency        <- target the sandbox must NOT reach
    sandbox = mkdtempSync(join(tmpdir(), "agency-sandbox-"));
    writeFileSync(
      join(sandbox, "inside.agency"),
      `node main() { return "ok" }`,
      "utf-8",
    );
    outsideFile = join(sandbox, "..", "outside.agency");
    writeFileSync(
      outsideFile,
      `node main() { return "should not be reachable" }`,
      "utf-8",
    );
  });

  afterAll(() => {
    try { rmSync(sandbox, { recursive: true }); } catch (_) { /* best effort */ }
    try { rmSync(outsideFile); } catch (_) { /* best effort */ }
  });

  it("compiles a file that lives inside the sandbox dir", () => {
    const result = _compileFile(sandbox, "inside.agency");
    expect(result.moduleId).toBeTruthy();
    expect(result.path).toContain(result.moduleId);
  });

  it("rejects a filename containing .. that escapes the sandbox", () => {
    expect(() => _compileFile(sandbox, "../outside.agency")).toThrowError(
      /Sandbox violation/,
    );
  });

  it("rejects an absolute filename outside the sandbox", () => {
    expect(() => _compileFile(sandbox, outsideFile)).toThrowError(
      /Sandbox violation/,
    );
  });

  it("rejects a symlink that points outside the sandbox", () => {
    // Create a symlink inside the sandbox that points to a file outside.
    // realpath on the symlink should resolve to the outside path, which
    // then fails the startsWith check.
    const link = join(sandbox, "evil.agency");
    try {
      symlinkSync(outsideFile, link);
    } catch (_) {
      // Symlink creation may fail on some CI environments; skip in that case.
      return;
    }
    expect(() => _compileFile(sandbox, "evil.agency")).toThrowError(
      /Sandbox violation/,
    );
  });
});
