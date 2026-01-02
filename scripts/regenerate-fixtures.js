#!/usr/bin/env node

const { parseADL } = require("../dist/lib/parser.js");
const {
  generateTypeScript,
} = require("../dist/lib/backends/typescriptGenerator.js");
const fs = require("fs");
const path = require("path");

const fixturesDir = path.join(__dirname, "../tests/typescriptGenerator");

function regenerateFixtures(dir, relativePath = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      regenerateFixtures(fullPath, path.join(relativePath, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".adl")) {
      const baseName = entry.name.replace(".adl", "");
      const mtsPath = path.join(dir, `${baseName}.mts`);

      const adlContent = fs.readFileSync(fullPath, "utf-8");
      const parseResult = parseADL(adlContent);

      if (parseResult.success) {
        const tsCode = generateTypeScript(parseResult.result);
        fs.writeFileSync(mtsPath, tsCode, "utf-8");
        const fixtureRelPath = path.join(relativePath, baseName) || baseName;
        console.log(`✓ Updated ${fixtureRelPath}.mts`);
      } else {
        console.error(`✗ Failed to parse ${fullPath}: ${parseResult.message}`);
      }
    }
  }
}

console.log("Regenerating fixture files...\n");
regenerateFixtures(fixturesDir);
console.log("\nDone!");
