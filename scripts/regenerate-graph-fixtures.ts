#!/usr/bin/env node

import path, { dirname } from "path";
import fs from "fs";
import { generateGraph } from "../lib/backends/graphGenerator.js";
import { parseAgency } from "../lib/parser.js";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesDir = path.join(__dirname, "../../tests/graphGenerator");

function regenerateFixtures(dir: string, relativePath = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      regenerateFixtures(fullPath, path.join(relativePath, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".agency")) {
      const baseName = entry.name.replace(".agency", "");
      const mtsPath = path.join(dir, `${baseName}.mts`);

      const agencyContent = fs.readFileSync(fullPath, "utf-8");
      const parseResult = parseAgency(agencyContent);

      if (parseResult.success) {
        const graphCode = generateGraph(parseResult.result);
        fs.writeFileSync(mtsPath, graphCode, "utf-8");
        const fixtureRelPath = path.join(relativePath, baseName) || baseName;
        console.log(`✓ Updated ${fixtureRelPath}.mts`);
      } else {
        console.error(`✗ Failed to parse ${fullPath}: ${parseResult.message}`);
      }
    }
  }
}

console.log("Regenerating graph generator fixture files...\n");
regenerateFixtures(fixturesDir);
console.log("\nDone!");
