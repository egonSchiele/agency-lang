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
    const result = compileSource(source, { typeCheck: true });
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
      expect(result.errors[0].toLowerCase()).toContain("import");
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
});
