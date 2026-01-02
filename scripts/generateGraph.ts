import * as fs from "fs";
import { parseADL } from "@/parser";
import { getDebugMessage } from "tarsec";
import { exit } from "process";
import { generateGraph } from "@/backends/graphGenerator";

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

if (!result.success) {
  const message = getDebugMessage();
  if (message) {
    console.error("Debug Info:\n" + message);
  }
  exit(1);
}

const code = generateGraph(result.result);
console.log(code);
