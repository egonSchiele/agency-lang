import { generateAgency } from "@/backends/agencyGenerator.js";
import { generateDeclarations } from "@/backends/declarationGenerator.js";
import { AgencyConfig } from "@/config.js";
import { AgencyProgram, generateTypeScript } from "@/index.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { typeCheck, formatErrors } from "@/typeChecker.js";
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

export function resetCompilationCache(): void {
  compiledFiles.clear();
}

export function compile(
  config: AgencyConfig,
  inputFile: string,
  _outputFile?: string,
  options?: { ts?: boolean },
): string | null {
  // Check if the input is a directory
  const stats = fs.statSync(inputFile);
  const verbose = config.verbose ?? false;
  if (stats.isDirectory()) {
    for (const { path } of findRecursively(inputFile)) {
      compile(config, path, undefined, options);
    }
    return null;
  }

  // Resolve the absolute path of the input file to avoid duplicates
  const absoluteInputFile = path.resolve(inputFile);
  const ext = options?.ts ? ".ts" : ".js";
  let outputFile = _outputFile || inputFile.replace(".agency", ext);
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

  // Run type checking if enabled via config
  if (config.typeCheck || config.typeCheckStrict) {
    const { errors } = typeCheck(parsedProgram, config);
    if (errors.length > 0) {
      if (config.typeCheckStrict) {
        console.error(formatErrors(errors));
        process.exit(1);
      } else {
        console.warn(formatErrors(errors, "warning"));
      }
    }
  }

  const imports = getImports(parsedProgram);

  const inputDir = path.dirname(absoluteInputFile);
  for (const importPath of imports) {
    const absPath = path.resolve(inputDir, importPath);
    if (config.restrictImports) {
      const projectRoot = process.cwd();
      if (
        !absPath.startsWith(projectRoot + path.sep) &&
        absPath !== projectRoot
      ) {
        throw new Error(
          `Import path '${importPath}' resolves to '${absPath}' which is outside the project directory '${projectRoot}'.`,
        );
      }
    }
    compile(config, absPath, undefined, options);
  }

  // Update the import path in the AST to reference the new .ts file
  parsedProgram.nodes.forEach((node) => {
    if (node.type === "importStatement") {
      node.modulePath = node.modulePath.replace(".agency", ext);
    }
  });

  let generatedCode = generateTypeScript(parsedProgram, config);
  if (options?.ts) {
    generatedCode = "//@ts-nocheck\n" + generatedCode;
  }
  fs.writeFileSync(outputFile, generatedCode, "utf-8");

  // Generate .d.ts declarations if enabled
  if (config.declarations) {
    const declarations = generateDeclarations(parsedProgram, config);
    const dtsFile = outputFile.replace(/\.(js|ts)$/, ".d.ts");
    fs.writeFileSync(dtsFile, declarations, "utf-8");
    console.log(`${inputFile} → ${dtsFile}`);
  }

  console.log(`${inputFile} → ${outputFile}`);

  return outputFile;
}

export function run(
  config: AgencyConfig,
  inputFile: string,
  outputFile?: string,
  resumeFile?: string,
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

  const env = resumeFile
    ? { ...process.env, AGENCY_RESUME_FILE: resumeFile }
    : process.env;

  const nodeProcess = spawn("node", [output], {
    stdio: "inherit",
    shell: false,
    env,
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
