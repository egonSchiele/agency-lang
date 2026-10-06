import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { builtinModules } from "module";
import path from "path";

// The header is the import block at the top of every compiled program. What
// it imports, every program imports, so this test pins down what it must not
// reach for.
const HEADER_PATH = path.resolve(
  process.cwd(),
  "lib/templates/backends/typescriptGenerator/imports.mustache",
);

// Both import forms: `import { x } from "m"` and the bare `import "m"`.
function importedModules(source: string): string[] {
  const withBindings = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)];
  const bare = [...source.matchAll(/^import\s+"([^"]+)"/gm)];
  return [...withBindings, ...bare].map((match) => match[1]);
}

describe("the generated header", () => {
  const header = readFileSync(HEADER_PATH, "utf8");

  // "agency-lang" is the package's main entry. It exports the compiler, so a
  // program that imports anything from it pulls the parser and the type
  // checker into its bundle. Generated code gets what it needs from
  // "agency-lang/runtime" instead.
  it("does not import from the package's main entry", () => {
    const modules = importedModules(header);
    expect(modules).not.toContain("agency-lang");
  });

  // A browser cannot resolve a Node module, so the header must not import
  // one. It reaches the platform through the host instead
  // (docs/dev/runtime/host.md).
  it("does not import a Node module", () => {
    const nodeModules = builtinModules.flatMap((name) => [name, `node:${name}`]);
    for (const module of importedModules(header)) {
      expect(nodeModules).not.toContain(module);
    }
  });

  it("imports only the runtime and the bundled zod", () => {
    expect([...new Set(importedModules(header))].sort()).toEqual([
      "agency-lang/runtime",
      "agency-lang/zod",
    ]);
  });

  it("sees both import forms", () => {
    const modules = importedModules('import { a } from "one";\nimport "two";\n');
    expect(modules).toEqual(["one", "two"]);
  });
});
