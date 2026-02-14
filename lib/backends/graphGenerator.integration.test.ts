import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateGraph } from "./graphGenerator.js";
import fs from "fs";
import path from "path";

/**
 * Interface representing a test fixture pair (.agency and .mjs files)
 */
interface FixturePair {
  name: string; // e.g., "simple", "multipleNodes"
  agencyPath: string; // absolute path to .agency file
  mtsPath: string; // absolute path to .mjs file
  agencyContent: string; // pre-read Agency source
  expectedGraph: string; // pre-read expected graph code
}

/**
 * Recursively discovers all .agency/.mjs fixture pairs in a directory
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
        // Found an Agency file - look for corresponding .mjs
        const baseName = entry.name.replace(".agency", "");
        const mtsPath = path.join(dir, `${baseName}.mjs`);

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
              expectedGraph: fs.readFileSync(mtsPath, "utf-8"),
            });
          } catch (error) {
            console.error(
              `Cannot read fixture ${fullPath}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        } else {
          console.warn(`Warning: No corresponding .mjs file for ${fullPath}`);
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

const FIXTURES_DIR = path.resolve(__dirname, "../../tests/graphGenerator");

describe("Graph Generator Integration Tests", () => {
  const fixtures = discoverFixtures(FIXTURES_DIR);

  // Guard against no fixtures found
  if (fixtures.length === 0) {
    it("should find test fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, agencyPath, mtsPath, agencyContent, expectedGraph }) => {
      it("should generate correct graph output", () => {
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

        // 3. Generate graph code
        let generatedGraph: string;
        try {
          generatedGraph = generateGraph(parseResult.result);
        } catch (error) {
          const errorMessage = [
            `Failed to generate graph code for fixture: ${name}`,
            `File: ${agencyPath}`,
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            ``,
            `Parsed AST:`,
            JSON.stringify(parseResult.result, null, 2),
          ].join("\n");
          throw new Error(errorMessage);
        }

        // 4. Normalize and compare
        const normalizedGenerated = normalizeWhitespace(generatedGraph);
        const normalizedExpected = normalizeWhitespace(expectedGraph);

        // 5. Assert equality with helpful diff
        expect(normalizedGenerated).toBe(normalizedExpected);
      });
    }
  );
});
