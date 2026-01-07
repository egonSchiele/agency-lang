import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";
import fs from "fs";
import path from "path";

/**
 * Interface representing a test fixture pair (.agency and .mts files)
 */
interface FixturePair {
  name: string; // e.g., "array", "types/literal"
  agencyPath: string; // absolute path to .agency file
  mtsPath: string; // absolute path to .mts file
  agencyContent: string; // pre-read Agency source
  expectedTS: string; // pre-read expected TypeScript
}

/**
 * Recursively discovers all .agency/.mts fixture pairs in a directory
 */
function discoverFixtures(fixtureDir: string): FixturePair[] {
  const fixtures: FixturePair[] = [];

  function scanDirectory(dir: string, relativePath: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        scanDirectory(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".agency")) {
        // Found an Agency file - look for corresponding .mts
        const baseName = entry.name.replace(".agency", "");
        const mtsPath = path.join(dir, `${baseName}.mts`);

        if (fs.existsSync(mtsPath)) {
          const nameWithoutExt = relativePath
            ? `${relativePath}/${baseName}`
            : baseName;

          try {
            fixtures.push({
              name: nameWithoutExt,
              agencyPath: fullPath,
              mtsPath: mtsPath,
              agencyContent: fs.readFileSync(fullPath, "utf-8"),
              expectedTS: fs.readFileSync(mtsPath, "utf-8"),
            });
          } catch (error) {
            console.error(
              `Cannot read fixture ${fullPath}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        } else {
          console.warn(`Warning: No corresponding .mts file for ${fullPath}`);
        }
      }
    }
  }

  scanDirectory(fixtureDir);
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Normalizes whitespace in generated code for comparison
 * Handles cross-platform line endings and trailing whitespace
 */
function normalizeWhitespace(code: string): string {
  return (
    code
      // Normalize line endings to \n
      .replace(/\r\n/g, "\n")
      // Remove trailing whitespace from each line
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Collapse multiple consecutive blank lines to single blank line
      .replace(/\n\n\n+/g, "\n\n")
      // Trim leading/trailing blank lines
      .trim()
      // Ensure single trailing newline
      .concat("\n")
  );
}

const FIXTURES_DIR = path.resolve(__dirname, "../../tests/typescriptGenerator");

describe("TypeScript Backend Integration Tests", () => {
  const fixtures = discoverFixtures(FIXTURES_DIR);

  // Guard against no fixtures found
  if (fixtures.length === 0) {
    it("should find test fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, agencyPath, mtsPath, agencyContent, expectedTS }) => {
      it("should generate correct TypeScript output", () => {
        // 1. Parse Agency
        const parseResult = parseAgency(agencyContent);

        // 2. Assert parsing succeeded
        if (!parseResult.success) {
          const errorMessage = [
            `Failed to parse Agency fixture: ${name}`,
            `File: ${agencyPath}`,
            `Error: ${parseResult.message}`,
            ``,
            `Agency Content:`,
            agencyContent,
          ].join("\n");
          throw new Error(errorMessage);
        }

        // 3. Generate TypeScript
        let generatedTS: string;
        try {
          generatedTS = generateTypeScript(parseResult.result);
        } catch (error) {
          const errorMessage = [
            `Failed to generate TypeScript for fixture: ${name}`,
            `File: ${agencyPath}`,
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            ``,
            `Parsed AST:`,
            JSON.stringify(parseResult.result, null, 2),
          ].join("\n");
          throw new Error(errorMessage);
        }

        // 4. Normalize and compare
        const normalizedGenerated = normalizeWhitespace(generatedTS);
        const normalizedExpected = normalizeWhitespace(expectedTS);

        // 5. Assert equality with helpful diff
        expect(normalizedGenerated).toBe(normalizedExpected);
      });
    }
  );
});
