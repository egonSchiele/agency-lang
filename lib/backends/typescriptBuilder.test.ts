import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";
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
          fixtures.push({
            name: nameWithoutExt,
            agencyPath: fullPath,
            mtsPath,
            agencyContent: fs.readFileSync(fullPath, "utf-8"),
            expectedTS: fs.readFileSync(mtsPath, "utf-8"),
          });
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

const FIXTURES_DIR = path.resolve(
  __dirname,
  "../../tests/typescriptGenerator",
);

describe("TypeScriptBuilder roundtrip tests", () => {
  const fixtures = discoverFixtures(FIXTURES_DIR);

  if (fixtures.length === 0) {
    it("should find test fixtures", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, agencyPath, agencyContent }) => {
      it("builder output matches existing generator output", () => {
        const parseResult = parseAgency(agencyContent);
        if (!parseResult.success) {
          throw new Error(
            `Failed to parse fixture: ${name}\nFile: ${agencyPath}\nError: ${parseResult.message}`,
          );
        }

        // Generate with existing generator
        const existingOutput = generateTypeScript(parseResult.result);

        // Generate with builder pipeline
        const preprocessor = new TypescriptPreprocessor(parseResult.result);
        const preprocessedProgram = preprocessor.preprocess();
        const builder = new TypeScriptBuilder();
        const ir = builder.build(preprocessedProgram);
        const builderOutput = printTs(ir);

        // Compare normalized output
        expect(normalizeWhitespace(builderOutput)).toBe(
          normalizeWhitespace(existingOutput),
        );
      });
    },
  );
});
