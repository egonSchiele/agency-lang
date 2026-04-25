import { generateAgency } from "@/backends/agencyGenerator.js";
import { AgencyConfig, loadConfigSafe } from "@/config.js";
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
import {
  CompileStrategy,
  RunStrategy,
  type ImportStrategy,
} from "../importStrategy.js";
import { parseAgency } from "../parser.js";
import { findRecursively, getImports } from "./util.js";

// Load configuration from agency.json
export function loadConfig(
  configPath?: string,
  verbose: boolean = false,
): AgencyConfig {
  const finalConfigPath = configPath || path.join(process.cwd(), "agency.json");

  if (verbose) {
    console.log(`Looking for config at: ${finalConfigPath}`);
  }

  const { config, error } = loadConfigSafe(finalConfigPath);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  if (config.verbose) {
    console.log(`Loaded config from ${finalConfigPath}`);
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
    process.exit(1);
  }

  return parseResult.result;
}

export function readFile(inputFile: string): string {
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file '${inputFile}' not found`);
    process.exit(1);
  }

  return fs.readFileSync(inputFile, "utf-8");
}

const compiledFiles: Set<string> = new Set();

export function resetCompilationCache(): void {
  compiledFiles.clear();
}

export function compile(
  config: AgencyConfig,
  inputFile: string,
  _outputFile?: string,
  options?: {
    ts?: boolean;
    symbolTable?: SymbolTable;
    importStrategy?: ImportStrategy;
  },
): string | null {
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file '${inputFile}' not found`);
    process.exit(1);
  }
  const stats = fs.statSync(inputFile);
  const verbose = config.verbose ?? false;
  if (stats.isDirectory()) {
    for (const { path } of findRecursively(inputFile)) {
      compile(config, path, undefined, options);
    }
    return null;
  }

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
  if (compiledFiles.has(absoluteInputFile)) {
    return outputFile;
  }

  compiledFiles.add(absoluteInputFile);

  const contents = readFile(inputFile);
  const isStdlibIndex =
    absoluteInputFile === path.join(getStdlibDir(), "index.agency");
  const parsedProgram = parse(contents, config, !isStdlibIndex);

  const symbolTable =
    options?.symbolTable ?? buildSymbolTable(absoluteInputFile, config);

  const resolvedProgram = resolveImports(
    parsedProgram,
    symbolTable,
    absoluteInputFile,
  );
  const info = collectProgramInfo(resolvedProgram, symbolTable);

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
  const strategy =
    options?.importStrategy ?? new CompileStrategy({ targetExt: ".js" });
  const nonAgencyImports: string[] = [];

  resolvedProgram.nodes.forEach((node) => {
    if (node.type !== "importStatement") return;
    if (isStdlibImport(node.modulePath) || isPkgImport(node.modulePath)) return;

    node.modulePath = strategy.rewriteImport(
      node.modulePath,
      absoluteInputFile,
    );

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
    fs.writeFileSync(outputFile, "// @ts-nocheck\n" + generatedCode, "utf-8");
  } else {
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

export async function format(
  contents: string,
  config: AgencyConfig = {},
): Promise<string> {
  const program = parse(contents, config, false);
  return generateAgency(program);
}

export async function formatFile(
  inputFile: string,
  inPlace: boolean = false,
  config: AgencyConfig = {},
): Promise<void> {
  const stats = fs.statSync(inputFile);
  if (stats.isDirectory()) {
    for (const { path } of findRecursively(inputFile)) {
      formatFile(path, inPlace, config);
    }
    return;
  }

  const contents = readFile(inputFile);

  const formatted = await format(contents, config);
  if (inPlace) {
    fs.writeFileSync(inputFile, formatted, "utf-8");
    console.log(`Formatted: ${inputFile}`);
  } else {
    console.log(formatted);
  }
}

export function run(
  config: AgencyConfig,
  inputFile: string,
  outputFile?: string,
  resumeFile?: string,
): void {
  const output = compile(config, inputFile, outputFile, {
    importStrategy: new RunStrategy(),
  });
  if (output === null) {
    console.error("Error: No output file generated.");
    process.exit(1);
  }

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
