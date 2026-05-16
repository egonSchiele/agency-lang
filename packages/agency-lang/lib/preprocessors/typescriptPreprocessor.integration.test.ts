import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypescriptPreprocessor } from "./typescriptPreprocessor.js";
import { discoverFixturePairs } from "../../tests/fixtureDiscovery.js";
import path from "path";

const FIXTURES_DIR = path.resolve(
  __dirname,
  "../../tests/typescriptPreprocessor"
);

describe("TypeScript Preprocessor Integration Tests", () => {
  const fixtures = discoverFixturePairs(FIXTURES_DIR, ".json");

  // Guard against no fixtures found
  if (fixtures.length === 0) {
    it("should find test fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, filePath, agencyContent, companionContent }) => {
      it("should produce correct preprocessed AST", () => {
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

        // 3. Preprocess
        let preprocessedAST;
        try {
          const preprocessor = new TypescriptPreprocessor(parseResult.result);
          preprocessedAST = preprocessor.preprocess();
        } catch (error) {
          const errorMessage = [
            `Failed to preprocess fixture: ${name}`,
            `File: ${filePath}`,
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
          JSON.parse(companionContent),
          null,
          2
        );

        // 5. Assert equality
        expect(generatedJSON).toBe(normalizedExpected);
      });
    }
  );
});
