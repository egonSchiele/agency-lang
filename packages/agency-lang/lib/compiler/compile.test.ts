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

  it("rejects local relative imports when imports policy is stdlib-only", () => {
    const source = `
import { foo } from "./bar.agency"
node main() { return foo() }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("not allowed");
      expect(result.errors[0]).toContain("'./bar.agency'");
    }
  });

  it("rejects absolute-path .agency imports when imports policy is stdlib-only", () => {
    const source = `
import { foo } from "/abs/path/bar.agency"
node main() { return foo() }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("not allowed");
      expect(result.errors[0]).toContain("'/abs/path/bar.agency'");
    }
  });

  it("allows stdlib imports with stdlib-only imports policy", () => {
    const source = `
import { exists } from "std::shell"
node main() { return exists("/tmp") }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(true);
  });

  // --- Coverage for the previously-undetected hole: getImports() filters
  // out non-agency imports, which let raw npm/Node modules sail past the
  // restriction. compileSource now uses getAllImports() instead.
  it("rejects raw npm/Node module imports when imports policy is stdlib-only", () => {
    const source = `
import * as fs from "fs"
node main() { return "hi" }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("not allowed");
      expect(result.errors[0]).toContain("'fs'");
    }
  });

  it("rejects child_process imports when imports policy is stdlib-only", () => {
    const source = `
import { execSync } from "child_process"
node main() { return "hi" }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("'child_process'");
    }
  });

  it("rejects pkg:: imports when imports policy is stdlib-only", () => {
    const source = `
import { foo } from "pkg::some-package"
node main() { return foo() }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("not allowed");
      expect(result.errors[0]).toContain("'pkg::some-package'");
    }
  });

  // Negative control: without imports policy, raw npm/Node imports must
  // be allowed. This proves the rejection in the tests above is gated by
  // the flag, not happening unconditionally.
  it("allows raw npm/Node module imports when imports policy is unset", () => {
    const source = `
import * as fs from "fs"
node main() { return "hi" }
`;
    const result = compileSource(source, {});
    expect(result.success).toBe(true);
  });

  it("rejects 'import nodes' (importNodeStatement) when imports policy is stdlib-only", () => {
    const source = `
import nodes { helper } from "./helpers.agency"
node main() { return "hi" }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("not allowed");
      expect(result.errors[0]).toContain("helpers.agency");
    }
  });
});

describe("compileSource imports policy (Task 8)", () => {
  it("imports: { allowKinds: ['stdlib'] } matches legacy behavior", () => {
    const source = `
import { foo } from "./bar.agency"
node main() { return foo() }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("not allowed");
      expect(result.errors[0]).toContain("'./bar.agency'");
    }
  });

  it("imports policy reports EVERY violation, not just the first", () => {
    const source = `
import { foo } from "./bar.agency"
import * as fs from "fs"
import { x } from "pkg::y"
node main() { return foo() }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBe(3);
      const all = result.errors.join("\n");
      expect(all).toContain("'./bar.agency'");
      expect(all).toContain("'fs'");
      expect(all).toContain("'pkg::y'");
    }
  });

  it("allows pkg:: imports when included in allowKinds", () => {
    const source = `
import { x } from "pkg::y"
node main() { return 1 }
`;
    const result = compileSource(source, {
      imports: { allowKinds: ["stdlib", "pkg"] },
    });
    // Should pass the import check; further compilation may still fail on
    // missing pkg, but we expect the failure to NOT be about the import
    // policy itself.
    if (!result.success) {
      // Make sure the failure (if any) is not the policy rejecting the pkg.
      for (const err of result.errors) {
        expect(err).not.toMatch(/'pkg::y' is not allowed/);
      }
    }
  });
});
