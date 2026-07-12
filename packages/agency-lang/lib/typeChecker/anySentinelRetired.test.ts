import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Recursive so a future subdir under lib/typeChecker is not silently dropped.
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(dir);

// A cheap tripwire backing the type-level guarantee (#472), not a proof: once
// every signature is VariableType, the "any" string sentinel is
// unrepresentable. This catches a stray hand-edit that slips past the compiler
// or formatter.
describe("the 'any' string sentinel stays retired (#472)", () => {
  it('no signature unions VariableType with the "any" string', () => {
    // Match `| "any"` and `"any" |` with any spacing, so a formatter-evading
    // hand-edit or reversed member order is still caught.
    const re = /(\|\s*"any")|("any"\s*\|)/;
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      expect(re.test(src), path.basename(file)).toBe(false);
    }
  });

  it('no file returns the bare "any" string', () => {
    const re = /return\s+\(?\s*"any"/;
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      expect(re.test(src), path.basename(file)).toBe(false);
    }
  });

  it("no inline object-form any-check outside isAnyType", () => {
    // The one legitimate `.value === "any"` is isAnyType's body in utils.ts.
    const re = /\.value\s*===\s*"any"/;
    for (const file of files) {
      if (path.basename(file) === "utils.ts") continue;
      const src = fs.readFileSync(file, "utf8");
      expect(re.test(src), path.basename(file)).toBe(false);
    }
  });
});
