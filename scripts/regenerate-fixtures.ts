#!/usr/bin/env node

import path, { dirname } from "path";
import fs from "fs";
import { generateTypeScript } from "../lib/backends/typescriptGenerator.js";
import { TypescriptPreprocessor } from "../lib/preprocessors/typescriptPreprocessor.js";
import { parseAgency } from "../lib/parser.js";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesDir = path.join(__dirname, "../../tests/typescriptGenerator");
const preprocessorFixturesDir = path.join(
  __dirname,
  "../../tests/typescriptPreprocessor"
);

function regenerateFixtures(dir: string, relativePath = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      regenerateFixtures(fullPath, path.join(relativePath, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".agency")) {
      const baseName = entry.name.replace(".agency", "");
      const mtsPath = path.join(dir, `${baseName}.mjs`);

      const agencyContent = fs.readFileSync(fullPath, "utf-8");
      const parseResult = parseAgency(agencyContent);

      if (parseResult.success) {
        const tsCode = generateTypeScript(parseResult.result);
        fs.writeFileSync(mtsPath, tsCode, "utf-8");
        const fixtureRelPath = path.join(relativePath, baseName) || baseName;
        console.log(`✓ Updated ${fixtureRelPath}.mjs`);
      } else {
        console.error(`✗ Failed to parse ${fullPath}: ${parseResult.message}`);
      }
    }
  }
}

function regeneratePreprocessorFixtures(dir: string, relativePath = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      regeneratePreprocessorFixtures(
        fullPath,
        path.join(relativePath, entry.name)
      );
    } else if (entry.isFile() && entry.name.endsWith(".agency")) {
      const baseName = entry.name.replace(".agency", "");
      const jsonPath = path.join(dir, `${baseName}.json`);

      const agencyContent = fs.readFileSync(fullPath, "utf-8");
      const parseResult = parseAgency(agencyContent);

      if (parseResult.success) {
        const preprocessor = new TypescriptPreprocessor(parseResult.result);
        const preprocessed = preprocessor.preprocess();
        fs.writeFileSync(
          jsonPath,
          JSON.stringify(preprocessed, null, 2),
          "utf-8"
        );
        const fixtureRelPath = path.join(relativePath, baseName) || baseName;
        console.log(`✓ Updated ${fixtureRelPath}.json`);
      } else {
        console.error(`✗ Failed to parse ${fullPath}: ${parseResult.message}`);
      }
    }
  }
}

console.log("Regenerating fixture files...\n");

console.log("--- TypeScript Generator Fixtures ---");
regenerateFixtures(fixturesDir);

console.log("\n--- TypeScript Preprocessor Fixtures ---");
regeneratePreprocessorFixtures(preprocessorFixturesDir);

console.log("\nDone!");
