import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compileSource } from "./compile.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "reexport-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("re-export end-to-end compilation", () => {
  it("compiles a function re-export and emits a wrapper that calls the source", () => {
    const sourcePath = path.join(tmpDir, "source.agency");
    writeFileSync(sourcePath, `export def double(x: number): number { return x * 2 }\n`);

    const reexporterSrc = `export { double } from "${sourcePath}"\n`;
    const result = compileSource(reexporterSrc, {});

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error(result.errors);
      return;
    }
    // The compiled JS should contain the wrapper function with the local name
    expect(result.code).toContain("double");
  });

  it("compiles aliased re-exports", () => {
    const sourcePath = path.join(tmpDir, "source.agency");
    writeFileSync(sourcePath, `export def search(q: string): string { return q }\n`);

    const reexporterSrc = `export { search as wikipediaSearch } from "${sourcePath}"\n`;
    const result = compileSource(reexporterSrc, {});

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error(result.errors);
      return;
    }
    expect(result.code).toContain("wikipediaSearch");
  });

  it("compiles star re-exports", () => {
    const sourcePath = path.join(tmpDir, "source.agency");
    writeFileSync(
      sourcePath,
      `export def foo(): number { return 1 }
export def bar(): number { return 2 }
`,
    );

    const reexporterSrc = `export * from "${sourcePath}"\n`;
    const result = compileSource(reexporterSrc, {});

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error(result.errors);
      return;
    }
    expect(result.code).toContain("foo");
    expect(result.code).toContain("bar");
  });

  it("calls a re-exported function from a node in the same file", () => {
    const sourcePath = path.join(tmpDir, "source.agency");
    writeFileSync(sourcePath, `export def double(x: number): number { return x * 2 }\n`);

    const reexporterSrc = `export { double } from "${sourcePath}"
node main() { return double(21) }
`;
    const result = compileSource(reexporterSrc, {});

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error(result.errors);
    }
  });

  it("reports an error when re-exporting a missing symbol", () => {
    const sourcePath = path.join(tmpDir, "source.agency");
    writeFileSync(sourcePath, `export def foo() { return 1 }\n`);

    const reexporterSrc = `export { nope } from "${sourcePath}"\n`;
    const result = compileSource(reexporterSrc, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/not defined/);
    }
  });

  it("reports an error on re-export cycles", () => {
    const aPath = path.join(tmpDir, "a.agency");
    const bPath = path.join(tmpDir, "b.agency");
    writeFileSync(aPath, `export * from "${bPath}"\n`);
    writeFileSync(bPath, `export * from "${aPath}"\n`);

    const result = compileSource(`export * from "${aPath}"\n`, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/cycle/i);
    }
  });
});
