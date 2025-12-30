#!/usr/bin/env node
import { adlParser } from "./adlParser";
import { generateTypeScript } from "./backends/adlTypescript";
import * as fs from "fs";
import * as path from "path";

// Get filename from command line arguments
const inputFile = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile || !outputFile) {
  console.error("Usage: node lib/generate-ts-file.js <input.adl> <output.ts>");
  process.exit(1);
}

// Read and parse the ADL file
const contents = fs.readFileSync(inputFile, "utf-8");
const parseResult = adlParser(contents);

// Check if parsing was successful
if (!parseResult.success) {
  console.error("Parse error:");
  console.error(parseResult);
  process.exit(1);
}

const parsedProgram = parseResult.result;

// Generate TypeScript code
const generatedCode = generateTypeScript(parsedProgram);

// Write to output file
fs.writeFileSync(outputFile, generatedCode, "utf-8");

console.log(`Generated ${outputFile} from ${inputFile}`);
