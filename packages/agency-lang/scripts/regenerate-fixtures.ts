#!/usr/bin/env node

import path, { dirname } from "path";
import fs from "fs";
import { generateTypeScript } from "../lib/backends/typescriptGenerator.js";
import { TypescriptPreprocessor } from "../lib/preprocessors/typescriptPreprocessor.js";
import { parseAgency } from "../lib/parser.js";
import { collectProgramInfo } from "../lib/programInfo.js";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesDir = path.join(__dirname, "../../tests/typescriptGenerator");
const preprocessorFixturesDir = path.join(
  __dirname,
  "../../tests/typescriptPreprocessor"
);
const builderFixturesDir = path.join(__dirname, "../../tests/typescriptBuilder");

type Transform = (ast: any, fileName: string) => { content: string; ext: string };

const generatorTransform: Transform = (ast, fileName) => ({
  content: generateTypeScript(ast, undefined, undefined, fileName),
  ext: ".mjs",
});

const preprocessorTransform: Transform = (ast) => {
  const info = collectProgramInfo(ast);
  const preprocessor = new TypescriptPreprocessor(ast, {}, info);
  return { content: JSON.stringify(preprocessor.preprocess(), null, 2), ext: ".json" };
};

function regenerate(dir: string, transform: Transform, relativePath = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      regenerate(fullPath, transform, path.join(relativePath, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".agency")) {
      const baseName = entry.name.replace(".agency", "");
      const agencyContent = fs.readFileSync(fullPath, "utf-8");
      const parseResult = parseAgency(agencyContent, {}, false);

      if (parseResult.success) {
        const { content, ext } = transform(parseResult.result, entry.name);
        fs.writeFileSync(path.join(dir, `${baseName}${ext}`), content, "utf-8");
        const fixtureRelPath = path.join(relativePath, baseName) || baseName;
        console.log(`✓ Updated ${fixtureRelPath}${ext}`);
      } else {
        console.error(`✗ Failed to parse ${fullPath}: ${parseResult.message}`);
      }
    }
  }
}

console.log("Regenerating fixture files...\n");

console.log("--- TypeScript Generator Fixtures ---");
regenerate(fixturesDir, generatorTransform);

console.log("\n--- TypeScript Preprocessor Fixtures ---");
regenerate(preprocessorFixturesDir, preprocessorTransform);

console.log("\n--- TypeScript Builder Fixtures ---");
regenerate(builderFixturesDir, generatorTransform);

console.log("\nDone!");
