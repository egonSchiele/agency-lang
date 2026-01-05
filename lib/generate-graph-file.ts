#!/usr/bin/env node
import * as fs from "fs";
import { parseADL } from "@/parser";
import { generateGraph } from "@/backends/graphGenerator";

// Get filename from command line arguments
const inputFile = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile || !outputFile) {
  console.error(
    "Usage: node lib/generate-graph-file.js <input.adl> <output.mts>"
  );
  process.exit(1);
}

// Read and parse the ADL file
const contents = fs.readFileSync(inputFile, "utf-8");
const parseResult = parseADL(contents);

// Check if parsing was successful
if (!parseResult.success) {
  console.error("Parse error:");
  console.error(parseResult);
  process.exit(1);
}

const parsedProgram = parseResult.result;

const generatedCode = generateGraph(parsedProgram);

// Write to output file
fs.writeFileSync(outputFile, generatedCode, "utf-8");

console.log(`Generated ${outputFile} from ${inputFile}`);
