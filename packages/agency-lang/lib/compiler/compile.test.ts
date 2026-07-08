import { describe, it, expect } from "vitest";
import { compileSource, typeCheckSource } from "./compile.js";

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

  it("rejects compilation when a raise payload violates an effect declaration", () => {
    // End-to-end: the typed-effect-declarations feature is only useful if a
    // bad payload actually *blocks* compilation, not just produces a
    // typechecker diagnostic that gets ignored. This covers the wiring
    // from \`checkEffectPayloads\` → \`ctx.errors\` → compile failure.
    const source = `
effect app::read { dir: string }
node main() { raise app::read("m", { dir: 5 }) }
`;
    const result = compileSource(source, { typechecker: { enabled: true } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some((e) =>
          /Effect 'app::read' data field 'dir' has the wrong type/.test(e),
        ),
      ).toBe(true);
    }
  });

  it("compiles cleanly when a raise payload matches its effect declaration", () => {
    // Companion to the previous test — proves the typecheck wiring isn't
    // simply broken-on (rejecting everything).
    const source = `
effect app::read { dir: string }
node main() { raise app::read("m", { dir: "/tmp" }) }
`;
    const result = compileSource(source, { typechecker: { enabled: true } });
    expect(result.success).toBe(true);
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

describe("compileSource test-only imports", () => {
  // Regression guard for the sandbox trust boundary, added while green:
  // compileSource must never honor `import test` (it compiles agent-authored
  // source for the run() subprocess sandbox). `littlesisFetch` is a REAL
  // non-exported stdlib symbol, so if the privilege ever leaks, compilation
  // would SUCCEED and the success assertion below fails unambiguously.
  it("rejects import test under compileSource (subprocess sandbox never gets test-mode privilege)", () => {
    const source = `
import test { littlesisFetch } from "std::data/people/littlesis"
node main() { return 1 }
`;
    const result = compileSource(source, { imports: { allowKinds: ["stdlib"] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("only allowed under the test harness");
    }
  });

  // typeCheckSource is agent-reachable via std::agency typecheck, so it must
  // agree with execution: import test code that run() rejects must not
  // typecheck as valid. (The LSP allows it independently for editor DX.)
  it("rejects import test under typeCheckSource (agent-reachable typecheck agrees with execution)", () => {
    const source = `
import test { littlesisFetch } from "std::data/people/littlesis"
node main() { return 1 }
`;
    expect(() => typeCheckSource(source)).toThrow(/only allowed under the test harness/);
  });
});
