import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// The header is the import block at the top of every compiled program. What
// it imports, every program imports, so this test pins down what it must not
// reach for.
const HEADER_PATH = path.resolve(
  process.cwd(),
  "lib/templates/backends/typescriptGenerator/imports.mustache",
);

function importedModules(source: string): string[] {
  return [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)].map((match) => match[1]);
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
});
