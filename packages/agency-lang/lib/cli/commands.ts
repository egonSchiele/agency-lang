import { generateAgency } from "@/backends/agencyGenerator.js";
import { AgencyConfig, loadConfigSafe } from "@/config.js";
import { AgencyProgram, generateTypeScript } from "@/index.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { resolveReExports } from "@/preprocessors/resolveReExports.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatErrors, typeCheck } from "@/typeChecker/index.js";
import { spawn } from "child_process";
import { transformSync } from "esbuild";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

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
import { parseAgency, replaceBlankLines } from "../parser.js";
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
  lower: boolean = true,
): AgencyProgram {
  const verbose = config.verbose ?? false;
  const parseResult = parseAgency(contents, config, applyTemplate, lower);

  // Check if parsing was successful
  if (!parseResult.success) {
    if (parseResult.message) {
      console.error(`Failed to parse Agency program: ${parseResult.message}`);
    } else {
      console.error("Failed to parse Agency program.", contents.slice(0, 400));
    }
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
    options?.symbolTable ?? SymbolTable.build(absoluteInputFile, config);

  const reExportedProgram = resolveReExports(
    parsedProgram,
    symbolTable,
    absoluteInputFile,
  );
  const resolvedProgram = resolveImports(
    reExportedProgram,
    symbolTable,
    absoluteInputFile,
  );
  const info = buildCompilationUnit(
    resolvedProgram,
    symbolTable,
    absoluteInputFile,
    contents,
  );

  const tc = config.typechecker;
  if (tc?.enabled || tc?.strict) {
    const { errors } = typeCheck(resolvedProgram, config, info);
    if (errors.length > 0) {
      if (tc?.strict) {
        console.error(formatErrors(errors));
        const hasFatal = errors.some((e) => (e.severity ?? "error") === "error");
        if (hasFatal) process.exit(1);
      } else {
        console.warn(formatErrors(errors, "warning"));
      }
    }
  }

  const imports = getImports(resolvedProgram);

  for (const importPath of imports) {
    if (isStdlibImport(importPath) || isPkgImport(importPath)) continue;

    const absPath = resolveAgencyImportPath(importPath, absoluteInputFile);
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
  // Format path opts out of pattern lowering so the formatter sees the original
  // pattern AST and can print it back as pattern syntax.
  const program = parse(replaceBlankLines(contents), config, false, false);
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

/**
 * Does `import "agency-lang"` resolve from `fromDir`? Uses CommonJS
 * resolution via `createRequire`, which walks `node_modules` upward exactly
 * like Node's ESM resolver does for bare specifiers — so a `true` result
 * means the compiled JS's `import "agency-lang"` will also succeed.
 */
function isAgencyLangResolvableFrom(fromDir: string): boolean {
  try {
    // The path passed to createRequire only matters for its directory;
    // the file itself doesn't need to exist.
    const req = createRequire(path.join(fromDir, "__agency_probe__.js"));
    req.resolve("agency-lang");
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the directories that should be added to NODE_PATH so a process
 * spawned outside this package can still import `agency-lang` and its
 * transitive deps. Walks up from this file's location to find the
 * `agency-lang` package root, then returns:
 *   1. The `node_modules` directory containing it (lets `agency-lang`
 *      itself resolve, plus any sibling packages installed at the same
 *      level — e.g. globally-installed `zod`).
 *   2. The package's own `node_modules` (lets nested transitive deps
 *      resolve when npm chose not to hoist them — common for global
 *      installs).
 * Returns an empty array if the package root can't be located (e.g.
 * running from a non-standard layout); the caller should fall through
 * without setting NODE_PATH in that case.
 */
function findGlobalAgencyLangSearchPaths(): string[] {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return [];
  }
  while (true) {
    const pkgJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
        if (pkg.name === "agency-lang") {
          const paths: string[] = [];
          const parent = path.dirname(dir);
          if (path.basename(parent) === "node_modules") {
            paths.push(parent);
          }
          const ownNodeModules = path.join(dir, "node_modules");
          if (fs.existsSync(ownNodeModules)) {
            paths.push(ownNodeModules);
          }
          return paths;
        }
      } catch {
        // Malformed package.json — keep walking up.
      }
    }
    const next = path.dirname(dir);
    if (next === dir) return [];
    dir = next;
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

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (resumeFile) {
    env.AGENCY_RESUME_FILE = resumeFile;
  }

  // If `agency-lang` isn't resolvable from the directory that will run the
  // compiled output, we're almost certainly being invoked from a global
  // install (the `agency` CLI is on $PATH but Node's module resolver does
  // not consult npm's global prefix). Point NODE_PATH at the globally
  // installed copy so `import "agency-lang"` (and its transitive deps)
  // resolve, and warn the user that this is a fallback.
  const outputDir = path.dirname(path.resolve(output));
  if (!isAgencyLangResolvableFrom(outputDir)) {
    const fallbackPaths = findGlobalAgencyLangSearchPaths();
    if (fallbackPaths.length > 0) {
      const existing = env.NODE_PATH ? env.NODE_PATH.split(path.delimiter) : [];
      env.NODE_PATH = [...fallbackPaths, ...existing].join(path.delimiter);
      console.warn(
        `\nWarning: 'agency-lang' is not installed locally in ${outputDir}.\n` +
          `Falling back to the globally installed copy at:\n` +
          fallbackPaths.map((p) => `  ${p}`).join("\n") +
          `\nFor a more reliable setup, install it in your project:\n` +
          `  npm install agency-lang zod\n`,
      );
    }
  }

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
