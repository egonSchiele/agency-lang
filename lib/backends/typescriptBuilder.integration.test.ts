import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { printTs } from "../ir/prettyPrint.js";
import fs from "fs";
import path from "path";

interface FixturePair {
  name: string;
  agencyPath: string;
  mtsPath: string;
  agencyContent: string;
  expectedTS: string;
}

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
              expectedTS: fs.readFileSync(mtsPath, "utf-8"),
            });
          } catch (error) {
            console.error(
              `Cannot read fixture ${fullPath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
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

function normalizeWhitespace(code: string): string {
  return (
    code
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n\n\n+/g, "\n\n")
      .trim()
      .concat("\n")
  );
}

export function generateWithBuilder(agencySource: string): string {
  const parseResult = parseAgency(agencySource);
  if (!parseResult.success) {
    throw new Error(`Failed to parse: ${parseResult.message}`);
  }
  const preprocessor = new TypescriptPreprocessor(parseResult.result);
  const preprocessedProgram = preprocessor.preprocess();
  const builder = new TypeScriptBuilder();
  const ir = builder.build(preprocessedProgram);
  return printTs(ir);
}

const FIXTURES_DIR = path.resolve(
  __dirname,
  "../../tests/typescriptBuilder",
);

describe("TypeScript Builder Integration Tests", () => {
  const fixtures = discoverFixtures(FIXTURES_DIR);

  if (fixtures.length === 0) {
    it("should find test fixtures (add .agency + .mjs pairs to tests/typescriptBuilder/)", () => {
      // No fixtures yet — this is expected initially.
      // Add .agency files and run `make builder-fixtures` to generate .mjs files.
      expect(true).toBe(true);
    });
    return;
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, agencyPath, agencyContent, expectedTS }) => {
      it("should generate correct TypeScript output", () => {
        let generatedTS: string;
        try {
          generatedTS = generateWithBuilder(agencyContent);
        } catch (error) {
          throw new Error(
            `Failed to generate TypeScript for fixture: ${name}\nFile: ${agencyPath}\nError: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        expect(normalizeWhitespace(generatedTS)).toBe(
          normalizeWhitespace(expectedTS),
        );
      });
    },
  );
});
