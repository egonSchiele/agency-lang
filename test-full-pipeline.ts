import * as fs from "fs";
import { parseADL } from "@/parser";
import { generateTypeScript } from "@/backends/typescriptGenerator";

// Get filename from command line arguments
const filename = process.argv[2];

if (!filename) {
  console.error("Usage: node dist/test-full-pipeline.js <filename>");
  process.exit(1);
}

// Read and parse the ADL file
const contents = fs.readFileSync(filename, "utf-8");
const parseResult = parseADL(contents);

console.log("Input ADL file:");
console.log("=".repeat(80));
console.log(contents);
console.log("=".repeat(80));
console.log();

// Check if parsing was successful
if (parseResult.success) {
  const parsedProgram = parseResult.result;

  console.log("Parsed JSON:");
  console.log("=".repeat(80));
  console.log(JSON.stringify(parsedProgram, null, 2));
  console.log("=".repeat(80));
  console.log();

  console.log("Generated TypeScript:");
  console.log("=".repeat(80));
  const generatedCode = generateTypeScript(parsedProgram);
  console.log(generatedCode);
  console.log("=".repeat(80));
} else {
  console.error("Parse error:");
  console.error(parseResult);
  process.exit(1);
}
