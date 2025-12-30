import * as fs from "fs";
import { parseADL } from "./lib/parser";

// Get filename from command line arguments
const filename = process.argv[2];

if (!filename) {
  console.error("Usage: node index.ts <filename>");
  process.exit(1);
}

// Read file contents
const contents = fs.readFileSync(filename, "utf-8");

// Parse with adlParser
const result = parseADL(contents);

// Output the result
console.log(JSON.stringify(result, null, 2));
