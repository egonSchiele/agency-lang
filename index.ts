import * as fs from "fs";
import { parseADL } from "@/parser";
import { getDebugMessage } from "tarsec";

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
if (!result.success) {
  const message = getDebugMessage();
  if (message) {
    console.error("Debug Info:\n" + message);
  }
}

// Exit with appropriate code
process.exit(result.success ? 0 : 1);