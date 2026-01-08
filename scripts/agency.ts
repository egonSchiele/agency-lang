#!/usr/bin/env node
import { spawn } from "child_process";
import * as fs from "fs";
import { parseAgency } from "../lib/parser.js";
import { AgencyProgram, generateGraph } from "@/index.js";
import { generateAgency } from "@/backends/agencyGenerator.js";
import { ParserResult } from "tarsec";

function help(): void {
  console.log(`
Agency Language CLI

Usage:
  agency help                           Show this help message
  agency compile <input> [output]       Compile .agency file to TypeScript
  agency run <input> [output]           Compile and run .agency file
  agency format <input>                 Format .agency file in place
  agency parse <input>                  Parse .agency file and show AST
  agency <input>                        Compile and run .agency file (shorthand)

Arguments:
  input                                 Path to .agency input file
  output                                Path to output .ts file (optional)
                                        Default: <input-name>.ts

Examples:
  agency help                           Show help
  agency compile script.agency          Compile to script.ts
  agency compile script.agency out.ts   Compile to out.ts
  agency run script.agency              Compile and run script.agency
  agency script.agency                  Compile and run (shorthand)
`);
}

function parse(inputFile: string): AgencyProgram {
  // Validate input file
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file '${inputFile}' not found`);
    process.exit(1);
  }

  // Read and parse the Agency file
  const contents = fs.readFileSync(inputFile, "utf-8");
  const parseResult = parseAgency(contents);
  console.log(JSON.stringify(parseResult, null, 2));

  // Check if parsing was successful
  if (!parseResult.success) {
    console.error("Parse error:");
    console.error(parseResult);
    process.exit(1);
  }

  return parseResult.result;
}

function compile(inputFile: string, outputFile?: string): string {
  // Determine output file name
  const output = outputFile || inputFile.replace(".agency", ".ts");
  const parsedProgram = parse(inputFile);

  // Generate TypeScript code
  const generatedCode = generateGraph(parsedProgram);

  // Write to output file
  fs.writeFileSync(output, generatedCode, "utf-8");

  console.log(`Generated ${output} from ${inputFile}`);

  return output;
}

function run(inputFile: string, outputFile?: string): void {
  // Compile the file
  const output = compile(inputFile, outputFile);

  // Run the generated TypeScript file with Node.js
  console.log(`Running ${output}...`);
  console.log("---");

  const nodeProcess = spawn("node", [output], {
    stdio: "inherit",
    shell: false,
  });

  nodeProcess.on("error", (error) => {
    console.error(`Failed to run ${output}:`, error);
    process.exit(1);
  });

  nodeProcess.on("exit", (code) => {
    if (code !== 0) {
      process.exit(code || 1);
    }
  });
}

function format(inputFile: string): string {
  const parsedProgram = parse(inputFile);

  // Generate TypeScript code
  const generatedCode = generateAgency(parsedProgram);

  // Write to output file
  //fs.writeFileSync(inputFile, generatedCode, "utf-8");

  //  console.log(`Generated ${output} from ${inputFile}`);
  console.log(generatedCode);

  return generatedCode;
}

// Main CLI logic
function main(): void {
  const args = process.argv.slice(2);

  // No arguments - show help
  if (args.length === 0) {
    help();
    return;
  }

  const command = args[0];

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      help();
      break;

    case "compile":
      if (args.length < 2) {
        console.error("Error: 'compile' command requires an input file");
        console.error("Usage: agency compile <input> [output]");
        process.exit(1);
      }
      compile(args[1], args[2]);
      break;

    case "run":
      if (args.length < 2) {
        console.error("Error: 'run' command requires an input file");
        console.error("Usage: agency run <input> [output]");
        process.exit(1);
      }
      run(args[1], args[2]);
      break;

    case "fmt":
    case "format":
      if (args.length < 1) {
        console.error("Error: 'format' command requires an input file");
        console.error("Usage: agency format <input>");
        process.exit(1);
      }
      format(args[1]);
      break;

    case "parse":
      if (args.length < 1) {
        console.error("Error: 'parse' command requires an input file");
        console.error("Usage: agency parse <input>");
        process.exit(1);
      }
      parse(args[1]);
      break;

    default:
      // If first arg is not a recognized command, treat it as a file to run
      if (command.endsWith(".agency") || fs.existsSync(command)) {
        run(command, args[1]);
      } else {
        console.error(`Error: Unknown command '${command}'`);
        console.error("Run 'agency help' for usage information");
        process.exit(1);
      }
      break;
  }
}

main();
