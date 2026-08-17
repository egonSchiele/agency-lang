import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { countExportedEndpoints } from "./exportedEndpoints.js";
import { safeDeleteDirectory } from "@/utils.js";

// Compiling an .agency file resolves the stdlib prelude, so fixtures live under
// the repo's .agency-tmp (where node_modules resolves), not the OS temp dir.
const fixturesRoot = path.join(process.cwd(), ".agency-tmp", "exported-endpoints");
fs.mkdirSync(fixturesRoot, { recursive: true });

function writeFixture(name: string, source: string): string {
  const file = path.join(fixturesRoot, name);
  fs.writeFileSync(file, source, "utf-8");
  return file;
}

afterAll(() => {
  const result = safeDeleteDirectory(fixturesRoot, false);
  if (!result.success) {
    console.error(`exportedEndpoints fixture cleanup failed: ${result.message}`);
  }
});

describe("countExportedEndpoints", () => {
  it("counts zero for a bare (unexported) node", () => {
    const file = writeFixture("bare.agency", `node main() {\n  print("hi")\n}\n`);
    expect(countExportedEndpoints(file, {})).toEqual({ nodes: 0, functions: 0, imported: [] });
  });

  it("counts exported nodes and functions", () => {
    const file = writeFixture(
      "exported.agency",
      `export node main() {\n  print("hi")\n}\n\nexport def add(a: number, b: number): number {\n  return a + b\n}\n`,
    );
    expect(countExportedEndpoints(file, {})).toEqual({ nodes: 1, functions: 1, imported: [] });
  });

  it("reports exports that live only in an imported file", () => {
    writeFixture(
      "lib.agency",
      `export def helper(x: number): number {\n  return x + 1\n}\n\nexport node greet() {\n  return "hi"\n}\n`,
    );
    const file = writeFixture(
      "imports-only.agency",
      `import { helper } from "./lib.agency"\n\nnode main() {\n  return helper(1)\n}\n`,
    );
    expect(countExportedEndpoints(file, {})).toEqual({
      nodes: 0,
      functions: 0,
      imported: [{ file: "lib.agency", names: ["helper", "greet"] }],
    });
  });

  it("counts re-exported symbols as the entrypoint's own", () => {
    writeFixture("lib2.agency", `export def helper(x: number): number {\n  return x + 1\n}\n`);
    const file = writeFixture(
      "reexports.agency",
      `export { helper } from "./lib2.agency"\n\nnode main() {\n  return helper(1)\n}\n`,
    );
    expect(countExportedEndpoints(file, {})).toEqual({ nodes: 0, functions: 1, imported: [] });
  });
});
