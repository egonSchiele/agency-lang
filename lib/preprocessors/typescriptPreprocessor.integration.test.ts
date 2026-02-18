import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import fs from "fs";
import path from "path";

/**
 * Interface representing a test fixture pair (.agency and .json files)
 */
interface FixturePair {
  name: string; // e.g., "simple", "subdir/nested"
  agencyPath: string; // absolute path to .agency file
  jsonPath: string; // absolute path to .json file
  agencyContent: string; // pre-read Agency source
  expectedJSON: string; // pre-read expected JSON
}

/**
 * Recursively discovers all .agency/.json fixture pairs in a directory
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
        scanDirectory(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".agency")) {
        const baseName = entry.name.replace(".agency", "");
        const jsonPath = path.join(dir, `${baseName}.json`);

        if (fs.existsSync(jsonPath)) {
          const nameWithoutExt = relativePath
            ? `${relativePath}/${baseName}`
            : baseName;

          try {
            fixtures.push({
              name: nameWithoutExt,
              agencyPath: fullPath,
              jsonPath: jsonPath,
              agencyContent: fs.readFileSync(fullPath, "utf-8"),
              expectedJSON: fs.readFileSync(jsonPath, "utf-8"),
            });
          } catch (error) {
            console.error(
              `Cannot read fixture ${fullPath}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        } else {
          console.warn(`Warning: No corresponding .json file for ${fullPath}`);
        }
      }
    }
  }

  scanDirectory(fixtureDir);
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

const FIXTURES_DIR = path.resolve(
  __dirname,
  "../../tests/typescriptPreprocessor"
);

describe("TypeScript Preprocessor Integration Tests", () => {
  const fixtures = discoverFixtures(FIXTURES_DIR);

  // Guard against no fixtures found
  if (fixtures.length === 0) {
    it("should find test fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, agencyPath, jsonPath, agencyContent, expectedJSON }) => {
      it("should produce correct preprocessed AST", () => {
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

        // 3. Preprocess
        let preprocessedAST;
        try {
          const preprocessor = new TypescriptPreprocessor(parseResult.result);
          preprocessedAST = preprocessor.preprocess();
        } catch (error) {
          const errorMessage = [
            `Failed to preprocess fixture: ${name}`,
            `File: ${agencyPath}`,
            `Error: ${error instanceof Error ? error.message : String(error)}`,
            ``,
            `Parsed AST:`,
            JSON.stringify(parseResult.result, null, 2),
          ].join("\n");
          throw new Error(errorMessage);
        }

        // 4. Serialize and compare
        const generatedJSON = JSON.stringify(preprocessedAST, null, 2);
        const normalizedExpected = JSON.stringify(
          JSON.parse(expectedJSON),
          null,
          2
        );

        // 5. Assert equality
        expect(generatedJSON).toBe(normalizedExpected);
      });
    }
  );
});
