import { describe, it, expect } from "vitest";
import { compileSource } from "./compile.js";

describe("compileSource", () => {
  it("compiles valid Agency source to JavaScript", () => {
    const source = `node main() { return "hello" }`;
    const result = compileSource(source, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.code).toContain("function");
      expect(result.moduleId).toBeTruthy();
    }
  });

  it("returns errors for invalid syntax", () => {
    const source = `node main( { return "hello" }`;
    const result = compileSource(source, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("returns errors for type check failures when typeCheck is enabled", () => {
    const source = `
def foo(x: number): string { return x }
node main() { return foo(42) }
`;
    const result = compileSource(source, { typechecker: { enabled: true } });
    expect(result.success).toBe(false);
  });

  it("rejects local relative imports when restrictImports is set", () => {
    const source = `
import { foo } from "./bar.agency"
node main() { return foo() }
`;
    const result = compileSource(source, { restrictImports: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain(".agency file import");
      expect(result.errors[0]).toContain("'./bar.agency'");
    }
  });

  it("rejects absolute-path .agency imports when restrictImports is set", () => {
    const source = `
import { foo } from "/abs/path/bar.agency"
node main() { return foo() }
`;
    const result = compileSource(source, { restrictImports: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain(".agency file import");
      expect(result.errors[0]).toContain("'/abs/path/bar.agency'");
    }
  });

  it("allows stdlib imports with restrictImports", () => {
    const source = `
import { exists } from "std::shell"
node main() { return exists("/tmp") }
`;
    const result = compileSource(source, { restrictImports: true });
    expect(result.success).toBe(true);
  });

  // --- Coverage for the previously-undetected hole: getImports() filters
  // out non-agency imports, which let raw npm/Node modules sail past the
  // restriction. compileSource now uses getAllImports() instead.
  it("rejects raw npm/Node module imports when restrictImports is set", () => {
    const source = `
import * as fs from "fs"
node main() { return "hi" }
`;
    const result = compileSource(source, { restrictImports: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("npm/Node module import");
      expect(result.errors[0]).toContain("'fs'");
    }
  });

  it("rejects child_process imports when restrictImports is set", () => {
    const source = `
import { execSync } from "child_process"
node main() { return "hi" }
`;
    const result = compileSource(source, { restrictImports: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("'child_process'");
    }
  });

  it("rejects pkg:: imports when restrictImports is set", () => {
    const source = `
import { foo } from "pkg::some-package"
node main() { return foo() }
`;
    const result = compileSource(source, { restrictImports: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("package import");
      expect(result.errors[0]).toContain("'pkg::some-package'");
    }
  });

  // Negative control: without restrictImports, raw npm/Node imports must
  // be allowed. This proves the rejection in the tests above is gated by
  // the flag, not happening unconditionally.
  it("allows raw npm/Node module imports when restrictImports is NOT set", () => {
    const source = `
import * as fs from "fs"
node main() { return "hi" }
`;
    const result = compileSource(source, {});
    expect(result.success).toBe(true);
  });

  it("rejects 'import nodes' (importNodeStatement) when restrictImports is set", () => {
    const source = `
import nodes { helper } from "./helpers.agency"
node main() { return "hi" }
`;
    const result = compileSource(source, { restrictImports: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].toLowerCase()).toContain("tool/node import");
    }
  });
});
