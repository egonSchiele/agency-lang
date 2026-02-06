#!/usr/bin/env node
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseAgency } from "../lib/parser.js";
import { AgencyProgram, generateGraph } from "@/index.js";
import { generateAgency } from "@/backends/agencyGenerator.js";
import { ParserResult } from "tarsec";
import {
  ImportNodeStatement,
  ImportStatement,
} from "@/types/importStatement.js";

function help(): void {
  console.log(`
Agency Language CLI

Usage:
  agency help                           Show this help message
  agency compile <input> [output]       Compile .agency file or directory to TypeScript
  agency run <input> [output]           Compile and run .agency file
  agency format [input]                 Format .agency file (reads from stdin if no input)
  agency parse [input]                  Parse .agency file and show AST (reads from stdin if no input)
  agency <input>                        Compile and run .agency file (shorthand)

Arguments:
  input                                 Path to .agency input file or directory (or omit to read from stdin for format/parse)
  output                                Path to output .ts file (optional, ignored for directories)
                                        Default: <input-name>.ts

Flags:
  -v, --verbose                         Enable verbose logging during parsing

Examples:
  agency help                           Show help
  agency compile script.agency          Compile to script.ts
  agency compile script.agency out.ts   Compile to out.ts
  agency compile ./scripts              Compile all .agency files in directory
  agency run script.agency              Compile and run script.agency
  agency -v parse script.agency         Parse with verbose logging
  cat script.agency | agency format     Format from stdin
  echo "x = 5" | agency parse           Parse from stdin
  agency script.agency                  Compile and run (shorthand)
`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");

    process.stdin.on("data", (chunk) => {
      data += chunk;
    });

    process.stdin.on("end", () => {
      resolve(data);
    });

    process.stdin.on("error", (err) => {
      reject(err);
    });
  });
}

function parse(contents: string, verbose: boolean = false): AgencyProgram {
  const parseResult = parseAgency(contents, verbose);

  // Check if parsing was successful
  if (!parseResult.success) {
    console.error("Parse error:");
    console.error(parseResult);
    process.exit(1);
  }

  return parseResult.result;
}

function readFile(inputFile: string): string {
  // Validate input file
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file '${inputFile}' not found`);
    process.exit(1);
  }

  // Read and parse the Agency file
  const contents = fs.readFileSync(inputFile, "utf-8");
  return contents;
}

function getImports(program: AgencyProgram): string[] {
  const toolAndNodeImports = program.nodes
    .filter(
      (node) =>
        node.type === "importNodeStatement" ||
        node.type === "importToolStatement",
    )
    .map((node) => node.agencyFile.trim());
  const importStatements = program.nodes
    .filter((node) => node.type === "importStatement")
    .map((node) => (node as ImportStatement).modulePath.trim());

  return [...toolAndNodeImports, ...importStatements];
}

const compiledFiles: Set<string> = new Set();
const dirSearched: Set<string> = new Set();
function compile(
  inputFile: string,
  _outputFile?: string,
  verbose: boolean = false,
): string | null {
  // Check if the input is a directory
  const stats = fs.statSync(inputFile);

  if (stats.isDirectory()) {
    dirSearched.add(path.resolve(inputFile));
    // Find all .agency files in the directory
    const files = fs.readdirSync(inputFile);
    const agencyFiles = files.filter((file) => file.endsWith(".agency"));

    for (const file of agencyFiles) {
      const fullPath = path.join(inputFile, file);
      compile(fullPath, undefined, verbose);
    }

    // Find all subdirectories and compile their .agency files
    const subdirs = files.filter((file) => {
      const fullPath = path.join(inputFile, file);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const subdir of subdirs) {
      const fullSubdirPath = path.join(inputFile, subdir);
      const resolvedSubdirPath = path.resolve(fullSubdirPath);
      if (!dirSearched.has(resolvedSubdirPath)) {
        compile(fullSubdirPath, undefined, verbose);
      }
    }
    return null;
  }

  // Resolve the absolute path of the input file to avoid duplicates
  const absoluteInputFile = path.resolve(inputFile);
  const outputFile = _outputFile || inputFile.replace(".agency", ".ts");
  // Skip if already compiled
  if (compiledFiles.has(absoluteInputFile)) {
    return outputFile;
  }

  compiledFiles.add(absoluteInputFile);

  const contents = readFile(inputFile);
  const parsedProgram = parse(contents, verbose);

  const imports = getImports(parsedProgram);

  const inputDir = path.dirname(absoluteInputFile);
  for (const importPath of imports) {
    const absPath = path.resolve(inputDir, importPath);
    compile(absPath, undefined, verbose);
  }

  // Update the import path in the AST to reference the new .ts file
  parsedProgram.nodes.forEach((node) => {
    if (node.type === "importStatement") {
      node.modulePath = node.modulePath.replace(".agency", ".ts");
    }
  });

  const generatedCode = generateGraph(parsedProgram);
  fs.writeFileSync(outputFile, generatedCode, "utf-8");

  console.log(`Generated ${outputFile} from ${inputFile}`);

  return outputFile;
}

function run(
  inputFile: string,
  outputFile?: string,
  verbose: boolean = false,
): void {
  // Compile the file
  const output = compile(inputFile, outputFile, verbose);
  if (output === null) {
    console.error("Error: No output file generated.");
    process.exit(1);
  }

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

async function format(
  contents: string,
  verbose: boolean = false,
): Promise<string> {
  const parsedProgram = parse(contents, verbose);
  const generatedCode = generateAgency(parsedProgram);
  console.log(generatedCode);
  return generatedCode;
}

// Main CLI logic
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // No arguments - show help
  if (args.length === 0) {
    help();
    return;
  }

  // Extract verbose flag
  const verboseIndex = args.findIndex(
    (arg) => arg === "-v" || arg === "--verbose",
  );
  const verbose = verboseIndex !== -1;

  // Remove verbose flag from args
  const filteredArgs = args.filter(
    (arg) => arg !== "-v" && arg !== "--verbose",
  );

  const command = filteredArgs[0];

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      help();
      break;

    case "compile":
      if (filteredArgs.length < 2) {
        console.error(
          "Error: 'compile' command requires an input file or directory",
        );
        console.error("Usage: agency compile <input> [output]");
        process.exit(1);
      }
      compile(filteredArgs[1], filteredArgs[2], verbose);
      break;

    case "run":
      if (filteredArgs.length < 2) {
        console.error("Error: 'run' command requires an input file");
        console.error("Usage: agency run <input> [output]");
        process.exit(1);
      }
      run(filteredArgs[1], filteredArgs[2], verbose);
      break;

    case "fmt":
    case "format":
      let fmtContents;
      if (filteredArgs.length < 2) {
        fmtContents = await readStdin();
      } else {
        fmtContents = readFile(filteredArgs[1]);
      }
      format(fmtContents, verbose);
      break;

    case "ast":
    case "parse":
      let contents;
      if (filteredArgs.length < 2) {
        contents = await readStdin();
      } else {
        contents = readFile(filteredArgs[1]);
      }
      const result = parse(contents, verbose);
      console.log(JSON.stringify(result, null, 2));
      break;

    default:
      // If first arg is not a recognized command, treat it as a file to run
      if (command.endsWith(".agency") || fs.existsSync(command)) {
        run(command, filteredArgs[1], verbose);
      } else {
        console.error(`Error: Unknown command '${command}'`);
        console.error("Run 'agency help' for usage information");
        process.exit(1);
      }
      break;
  }
}

main();
