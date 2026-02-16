import { generateAgency } from "@/backends/agencyGenerator.js";
import { AgencyConfig } from "@/config.js";
import { AgencyProgram, generateGraph } from "@/index.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { ImportStatement } from "@/types/importStatement.js";
import { renderMermaidAscii } from "beautiful-mermaid";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseAgency } from "../parser.js";
import { findRecursively, getImports } from "./util.js";

// Load configuration from agency.json
export function loadConfig(
  configPath?: string,
  verbose: boolean = false,
): AgencyConfig {
  let config: AgencyConfig = {};

  // Determine config file path
  const defaultConfigPath = path.join(process.cwd(), "agency.json");
  const finalConfigPath = configPath || defaultConfigPath;

  if (verbose) {
    console.log(`Looking for config at: ${finalConfigPath}`);
  }

  // Check if config file exists
  if (fs.existsSync(finalConfigPath)) {
    try {
      const configContent = fs.readFileSync(finalConfigPath, "utf-8");
      config = JSON.parse(configContent);
      if (config.verbose) {
        console.log(`Loaded config from ${finalConfigPath}`);
      }
    } catch (error) {
      console.error(`Error loading config from ${finalConfigPath}:`, error);
      process.exit(1);
    }
  }

  return config;
}

export function readStdin(): Promise<string> {
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

export function parse(contents: string, config: AgencyConfig): AgencyProgram {
  const verbose = config.verbose ?? false;
  const parseResult = parseAgency(contents, config);

  // Check if parsing was successful
  if (!parseResult.success) {
    console.error("Parse error:");
    console.error(parseResult);
    process.exit(1);
  }

  return parseResult.result;
}

export function readFile(inputFile: string): string {
  // Validate input file
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file '${inputFile}' not found`);
    process.exit(1);
  }

  // Read and parse the Agency file
  const contents = fs.readFileSync(inputFile, "utf-8");
  return contents;
}

export function renderGraph(contents: string, config: AgencyConfig): void {
  const parsedProgram = parse(contents, config);
  const preprocessor = new TypescriptPreprocessor(parsedProgram, config);
  preprocessor.preprocess();
  const mermaid = preprocessor.renderMermaid();
  console.log("Program Mermaid Diagram:\n");
  mermaid.forEach((subgraph) => {
    const ascii = renderMermaidAscii(subgraph);
    console.log(ascii);
  });
  console.log("==========");
  mermaid.forEach((subgraph) => {
    console.log(subgraph);
  });
}

const compiledFiles: Set<string> = new Set();
export function compile(
  config: AgencyConfig,
  inputFile: string,
  _outputFile?: string,
): string | null {
  // Check if the input is a directory
  const stats = fs.statSync(inputFile);
  const verbose = config.verbose ?? false;
  if (stats.isDirectory()) {
    for (const { path } of findRecursively(inputFile)) {
      compile(config, path, undefined);
    }
    return null;
  }

  // Resolve the absolute path of the input file to avoid duplicates
  const absoluteInputFile = path.resolve(inputFile);
  let outputFile = _outputFile || inputFile.replace(".agency", ".js");
  if (config.outDir && !_outputFile) {
    const outputDir = path.resolve(config.outDir);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    outputFile = path.join(outputDir, outputFile);
  }
  // Skip if already compiled
  if (compiledFiles.has(absoluteInputFile)) {
    return outputFile;
  }

  compiledFiles.add(absoluteInputFile);

  const contents = readFile(inputFile);
  const parsedProgram = parse(contents, config);

  const imports = getImports(parsedProgram);

  const inputDir = path.dirname(absoluteInputFile);
  for (const importPath of imports) {
    const absPath = path.resolve(inputDir, importPath);
    compile(config, absPath, undefined);
  }

  // Update the import path in the AST to reference the new .ts file
  parsedProgram.nodes.forEach((node) => {
    if (node.type === "importStatement") {
      node.modulePath = node.modulePath.replace(".agency", ".js");
    }
  });

  const generatedCode = generateGraph(parsedProgram, config);
  fs.writeFileSync(outputFile, generatedCode, "utf-8");

  console.log(`${inputFile} → ${outputFile}`);

  return outputFile;
}

export function run(
  config: AgencyConfig,
  inputFile: string,
  outputFile?: string,
): void {
  // Compile the file
  const output = compile(config, inputFile, outputFile);
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

export async function format(
  contents: string,
  config: AgencyConfig,
): Promise<string> {
  const parsedProgram = parse(contents, config);
  const generatedCode = generateAgency(parsedProgram);
  return generatedCode;
}

export function formatFile(
  inputPath: string,
  inPlace: boolean,
  config: AgencyConfig,
): void {
  const stats = fs.statSync(inputPath);

  if (stats.isDirectory()) {
    for (const { path } of findRecursively(inputPath)) {
      formatFile(path, inPlace, config);
    }
    return;
  }

  // Format single file
  const contents = readFile(inputPath);
  const parsedProgram = parse(contents, config);
  const generatedCode = generateAgency(parsedProgram);

  if (inPlace) {
    fs.writeFileSync(inputPath, generatedCode, "utf-8");
    console.log(`Formatted ${inputPath}`);
  } else {
    console.log(generatedCode);
  }
}
