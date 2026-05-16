import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";
import { discoverFixturePairs } from "../../tests/fixtureDiscovery.js";
import path from "path";

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
  const fixtures = discoverFixturePairs(FIXTURES_DIR, ".mjs");

  // Guard against no fixtures found
  if (fixtures.length === 0) {
    it("should find test fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, filePath, agencyContent, companionPath, companionContent }) => {
      it("should generate correct TypeScript output", () => {
        // 1. Parse Agency
        const parseResult = parseAgency(agencyContent, {}, false);

        // 2. Assert parsing succeeded
        if (!parseResult.success) {
          const errorMessage = [
            `Failed to parse Agency fixture: ${name}`,
            `File: ${filePath}`,
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
          const moduleId = path.basename(name) + ".agency";
          generatedTS = generateTypeScript(parseResult.result, undefined, undefined, moduleId);
        } catch (error) {
          const errorMessage = [
            `Failed to generate TypeScript for fixture: ${name}`,
            `File: ${filePath}`,
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            ``,
            `Parsed AST:`,
            JSON.stringify(parseResult.result, null, 2),
          ].join("\n");
          throw new Error(errorMessage);
        }

        // 4. Normalize and compare
        const normalizedGenerated = normalizeWhitespace(generatedTS);
        const normalizedExpected = normalizeWhitespace(companionContent);

        // 5. Assert equality with helpful diff
        expect(normalizedGenerated).toBe(normalizedExpected);
      });
    }
  );
});
