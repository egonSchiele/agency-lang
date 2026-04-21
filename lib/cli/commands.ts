import { generateAgency } from "@/backends/agencyGenerator.js";
import { AgencyConfig } from "@/config.js";
import { AgencyProgram, generateTypeScript } from "@/index.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { collectProgramInfo } from "@/programInfo.js";
import { buildSymbolTable, type SymbolTable } from "@/symbolTable.js";
import { formatErrors, typeCheck } from "@/typeChecker/index.js";
import { spawn } from "child_process";
import { transformSync } from "esbuild";
import * as fs from "fs";
import * as path from "path";

import {
  getStdlibDir,
  isPkgImport,
  isStdlibImport,
  resolveAgencyImportPath,
} from "../importPaths.js";
import { CompileStrategy, RunStrategy, type ImportStrategy } from "../importStrategy.js";
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

export function parse(
  contents: string,
  config: AgencyConfig,
  applyTemplate: boolean = true,
): AgencyProgram {
  const verbose = config.verbose ?? false;
  const parseResult = parseAgency(contents, config, applyTemplate);

  // Check if parsing was successful
  if (!parseResult.success) {
    console.error("Failed to parse Agency program.");
    // console.error(parseResult);
    // throw new Error("Failed to parse Agency program");
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

const compiledFiles: Set<string> = new Set();

export function resetCompilationCache(): void {
  compiledFiles.clear();
}

export function compile(
  config: AgencyConfig,
  inputFile: string,
  _outputFile?: string,
  options?: { ts?: boolean; symbolTable?: SymbolTable; importStrategy?: ImportStrategy },
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
  const isStdlibIndex = absoluteInputFile === path.join(getStdlibDir(), "index.agency");
  const parsedProgram = parse(contents, config, !isStdlibIndex);

  // Build symbol table once at the top level, reuse for recursive calls
  const symbolTable =
    options?.symbolTable ?? buildSymbolTable(absoluteInputFile, config);
  // Resolve unified imports into specialized AST nodes
  const resolvedProgram = resolveImports(
    parsedProgram,
    symbolTable,
    absoluteInputFile,
  );
  const info = collectProgramInfo(resolvedProgram, symbolTable);

  // Run type checking if enabled via config
  if (config.typeCheck || config.typeCheckStrict) {
    const { errors } = typeCheck(resolvedProgram, config, info);
    if (errors.length > 0) {
      if (config.typeCheckStrict) {
        console.error(formatErrors(errors));
        process.exit(1);
      } else {
        console.warn(formatErrors(errors, "warning"));
      }
    }
  }

  const imports = getImports(resolvedProgram);

  for (const importPath of imports) {
    // stdlib and pkg imports are pre-compiled; don't recompile them
    if (isStdlibImport(importPath) || isPkgImport(importPath)) continue;

    const absPath = resolveAgencyImportPath(importPath, absoluteInputFile);
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
    compile(config, absPath, undefined, { ...options, symbolTable });
  }

  // Rewrite import paths in the AST using the import strategy
  const strategy = options?.importStrategy ?? new CompileStrategy({ targetExt: ext as ".js" | ".ts" });
  const nonAgencyImports: string[] = [];

  resolvedProgram.nodes.forEach((node) => {
    if (node.type !== "importStatement") return;
    if (isStdlibImport(node.modulePath) || isPkgImport(node.modulePath)) return;

    node.modulePath = strategy.rewriteImport(node.modulePath, absoluteInputFile);

    // Collect non-Agency imports for dependency preparation
    if (!node.modulePath.endsWith(".agency")) {
      nonAgencyImports.push(node.modulePath);
    }
  });

  try {
    strategy.prepareDependencies(nonAgencyImports, absoluteInputFile);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const moduleId = path.relative(process.cwd(), absoluteInputFile);
  const absoluteOutputFile = path.resolve(outputFile);
  const generatedCode = generateTypeScript(
    resolvedProgram,
    config,
    info,
    moduleId,
    absoluteOutputFile,
  );
  if (options?.ts) {
    // TypeScript output — add @ts-nocheck so type errors don't block compilation
    fs.writeFileSync(outputFile, "// @ts-nocheck\n" + generatedCode, "utf-8");
  } else {
    // JavaScript output — strip types with esbuild
    const result = transformSync(generatedCode, {
      loader: "ts",
      format: "esm",
      supported: { "top-level-await": true },
    });
    fs.writeFileSync(outputFile, result.code, "utf-8");
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
  // Compile the file with RunStrategy so dependencies are prepared for execution
  const output = compile(config, inputFile, outputFile, { importStrategy: new RunStrategy() });
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
  const parsedProgram = parse(contents, config, false);
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
