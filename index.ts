import { adlParser } from "./lib/adlParser";
import * as fs from "fs";

// Get filename from command line arguments
const filename = process.argv[2];

if (!filename) {
  console.error("Usage: node index.ts <filename>");
  process.exit(1);
}

// Read file contents
const contents = fs.readFileSync(filename, "utf-8");

// Parse with adlParser
const result = adlParser(contents);

// Output the result
console.log(JSON.stringify(result, null, 2));
