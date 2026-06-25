import { generateAgency } from "@/backends/agencyGenerator.js";
import { AgencyConfig, loadConfigSafe } from "@/config.js";
import { AgencyProgram, generateTypeScript } from "@/index.js";
import { initPlanForModule } from "@/backends/typescriptGenerator.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { resolveReExports } from "@/preprocessors/resolveReExports.js";
import { liftCallbackBlocks } from "@/preprocessors/liftCallbacks.js";
import { buildCompilationUnit, CompilationUnit } from "@/compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatErrors, typeCheck } from "@/typeChecker/index.js";
import {
  buildCompiledClosure,
  CompileClosureError,
  type CompiledClosure,
} from "@/compiler/compileClosure.js";
import { spawn } from "child_process";
import { transformSync } from "esbuild";
import * as fs from "fs";
import { createRequire } from "module";
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
import { parseAgency, replaceBlankLines } from "../parser.js";
import { fileURLToPath, pathToFileURL } from "url";
import {
  classifyInstall,
  installDirFromUrl,
  type InstallKind,
} from "./installLocation.js";
import { findRecursively, getImports } from "./util.js";

// Returns the file:// URL of the ESM loader-register shim shipped with the
// agency-lang package. Passing this to `node --import=<url>` causes Node to
// fall back to agency-lang's own node_modules when resolving bare specifiers,
// which lets `agency run` work even when agency-lang is installed globally.
//
// The shim lives at dist/lib/cli/runShim/register.mjs, right next to this
// file's compiled output (dist/lib/cli/commands.js), so we resolve it
// relative to this module's URL.
export function compiledOutputRegisterUrl(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return pathToFileURL(
    path.join(thisDir, "runShim", "register.mjs"),
  ).href;
}

// Build the argv prefix to use when spawning `node` on a compiled .agency
// output file. Always includes the resolver register so transitive bare
// imports (zod, smoltalk, etc.) resolve regardless of cwd or install kind.
export function compiledOutputNodeArgs(): string[] {
  return [`--import=${compiledOutputRegisterUrl()}`];
}

// Returns true if `agency-lang` resolves from a file inside the given
// directory using Node's standard CommonJS resolver. If true, the user
// can run `node compiled.js` from that location and it will succeed —
// no need to print the global-install warning.
export function agencyLangResolvesFrom(dir: string): boolean {
  try {
    // createRequire needs a file path inside the directory; the file
    // doesn't have to exist.
    const req = createRequire(path.join(path.resolve(dir), "x.js"));
    req.resolve("agency-lang");
    return true;
  } catch {
    return false;
  }
}

export function compileWarning(
  kind: InstallKind,
  outputContext: string,
  // Injected so tests can simulate a clean directory regardless of the
  // host's module-resolution state (vitest, for instance, patches Node
  // module resolution to find workspace packages from any cwd).
  resolvesFrom: (dir: string) => boolean = agencyLangResolvesFrom,
): string | null {
  if (kind !== "global") return null;
  const dir = fs.existsSync(outputContext) && fs.statSync(outputContext).isDirectory()
    ? outputContext
    : path.dirname(path.resolve(outputContext));
  if (resolvesFrom(dir)) return null;
  return [
    "",
    "Note: agency-lang is installed globally. Running `node <output>.js`",
    "directly may fail with ERR_MODULE_NOT_FOUND because Node does not",
    "resolve global packages for bare imports.",
    "  - Use  agency run <file>    to execute an agency file",
    "  - Use  agency pack <file>   to produce a portable single-file script",
    "",
  ].join("\n");
}

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
// Cached `CompiledClosure` for the current compile session. Built once
// at the outermost `compile()` call (when no per-file recursion is in
// progress) and reused by every per-file emit. Cleared by
// `resetCompilationCache()`.
let currentClosure: CompiledClosure | null = null;

export function resetCompilationCache(): void {
  compiledFiles.clear();
  currentClosure = null;
}

/**
 * Build the import-closure analysis once per compile session — at the
 * outermost call, before any recursive per-file compile() runs. The
 * recursive children reuse the cached closure to get per-module init
 * plans without re-parsing.
 *
 * "Outermost call" = no `options.symbolTable` (passed by recursive
 * children). When the outermost call's entry file changes (e.g. the
 * `agency test` runner iterates several .test.json fixtures in one
 * process), the cached closure no longer covers the new entry's
 * imports so we rebuild and drop the stale `compiledFiles` set.
 * Without that drop, downstream codegen would look up plans for
 * modules that aren't in the closure and emit an empty init plan.
 *
 * Stdlib files compile under their own entry (e.g., when a user runs
 * `agency compile std/...`) but most user code reaches them via
 * `import "std::..."`, which the closure walker intentionally skips.
 * Avoid building a closure rooted at a stdlib file — its imports are
 * structured differently and we don't need the analysis there.
 */
function ensureCompiledClosure(
  absoluteInputFile: string,
  config: AgencyConfig,
  hasSymbolTable: boolean,
  verbose: boolean,
): void {
  const isOutermostCall = !hasSymbolTable;
  const isStdlibEntry = absoluteInputFile.startsWith(getStdlibDir() + path.sep);
  const closureCoversEntry =
    currentClosure?.programs[absoluteInputFile] !== undefined;
  if (!isOutermostCall || isStdlibEntry || closureCoversEntry) return;

  currentClosure = null;
  compiledFiles.clear();
  try {
    const ccStartTime = performance.now();
    currentClosure = buildCompiledClosure(absoluteInputFile, config);
    const ccEndTime = performance.now();
    logTime({ label: "Built compile closure", start: ccStartTime, end: ccEndTime, verbose });
  } catch (e) {
    if (e instanceof CompileClosureError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

function runTypecheck(
  liftedProgram: AgencyProgram,
  config: AgencyConfig,
  info: CompilationUnit,
  absoluteInputFile: string,
  verbose: boolean,
): void {
  const tc = config.typechecker;
  if (!tc?.enabled && !tc?.strict) return;
  const tcStartTime = performance.now();
  const { errors } = typeCheck(liftedProgram, config, info);
  const tcEndTime = performance.now();
  logTime({ label: `Type checked ${absoluteInputFile}`, start: tcStartTime, end: tcEndTime, verbose });
  if (errors.length === 0) return;
  if (tc?.strict) {
    console.error(formatErrors(errors));
    const hasFatal = errors.some((e) => (e.severity ?? "error") === "error");
    if (hasFatal) process.exit(1);
  } else {
    console.warn(formatErrors(errors, "warning"));
  }
}

export function compile(
  config: AgencyConfig,
  inputFile: string,
  _outputFile?: string,
  options?: {
    ts?: boolean;
    symbolTable?: SymbolTable;
    importStrategy?: ImportStrategy;
    /** Suppress the per-file `input → output (in Nms)` progress line. */
    quiet?: boolean;
  },
): string | null {
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file '${inputFile}' not found`);
    process.exit(1);
  }
  const stats = fs.statSync(inputFile);
  const verbose = config.verbose ?? false;
  if (stats.isDirectory()) {
    const files = [...findRecursively(inputFile)].map((f) => f.path);
    // A directory is many entry points — every .agency file under it. To
    // avoid recompiling shared dependencies once per entry, build ONE
    // import closure covering all of them up front and reuse it for every
    // file. Without this, each sibling entry the previous closure didn't
    // cover would clear the per-session cache (see ensureCompiledClosure)
    // and recompile shared deps once per entry. Skipped for:
    //   - recursive child calls (a symbolTable was threaded in) — those
    //     aren't real top-level directory compiles; and
    //   - stdlib dirs, which intentionally compile without a closure (the
    //     same carve-out ensureCompiledClosure makes for stdlib entries).
    const absDir = path.resolve(inputFile);
    const isStdlibDir =
      absDir === getStdlibDir() || absDir.startsWith(getStdlibDir() + path.sep);
    if (!options?.symbolTable && !isStdlibDir && files.length > 0) {
      try {
        currentClosure = buildCompiledClosure(
          files.map((f) => path.resolve(f)),
          config,
        );
        // The fresh union closure supersedes anything cached for a prior
        // entry; drop the per-file set so codegen reruns under it.
        compiledFiles.clear();
      } catch (e) {
        if (e instanceof CompileClosureError) {
          console.error(e.message);
          process.exit(1);
        }
        throw e;
      }
    }
    for (const file of files) {
      compile(config, file, undefined, options);
    }
    return null;
  }

  const compileStartTime = performance.now();
  const absoluteInputFile = path.resolve(inputFile);

  ensureCompiledClosure(absoluteInputFile, config, !!options?.symbolTable, verbose);

  const ext = options?.ts ? ".ts" : ".js";
  // Anchor the replacement to the extension so that an absolute path
  // containing ".agency" as a substring in a parent directory (e.g.
  // "/Users/me/dev/worksy.agency-init/src/agent.agency") does not get
  // the first match clobbered. See issue #48.
  let outputFile = _outputFile || inputFile.replace(/\.agency$/, ext);
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

  const symbolTableStartTime = performance.now();
  const symbolTable =
    options?.symbolTable ?? SymbolTable.build(absoluteInputFile, config);

  const symbolTableEndTime = performance.now();
  logTime({ label: `Built symbol table for ${absoluteInputFile}`, start: symbolTableStartTime, end: symbolTableEndTime, verbose });

  const compilationUnitStartTime = performance.now();
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
  // Lift `callback("onX") { ... }` block bodies to top-level defs.
  // Must run BEFORE buildCompilationUnit and typecheck so the lifted defs
  // appear in functionDefinitions and get their bodies typechecked.
  const liftedProgram = liftCallbackBlocks(resolvedProgram);
  const info = buildCompilationUnit(
    liftedProgram,
    symbolTable,
    absoluteInputFile,
    contents,
  );
  const compilationUnitEndTime = performance.now();
  logTime({ label: `Built compilation unit for ${absoluteInputFile}`, start: compilationUnitStartTime, end: compilationUnitEndTime, verbose });

  runTypecheck(liftedProgram, config, info, absoluteInputFile, verbose);

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

  liftedProgram.nodes.forEach((node) => {
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
  // Per-module init plan view — derived from the cached closure if we
  // built one. Modules not in the closure (e.g., out-of-tree stdlib
  // compiles) fall through to the legacy path with no plan.
  const initPlan = currentClosure
    ? initPlanForModule(currentClosure, absoluteInputFile)
    : undefined;
  const codegenStartTime = performance.now();
  const generatedCode = generateTypeScript(
    liftedProgram,
    config,
    info,
    moduleId,
    absoluteOutputFile,
    initPlan,
  );
  const codegenEndTime = performance.now();
  logTime({ label: `Generated code for ${absoluteInputFile}`, start: codegenStartTime, end: codegenEndTime, verbose });
  if (options?.ts) {
    fs.writeFileSync(outputFile, "// @ts-nocheck\n" + generatedCode, "utf-8");
  } else {
    const esbuildStartTime = performance.now();
    const result = transformSync(generatedCode, {
      loader: "ts",
      format: "esm",
      supported: { "top-level-await": true },
    });
    fs.writeFileSync(outputFile, result.code, "utf-8");
    const esbuildEndTime = performance.now();
    logTime({ label: `Transformed code for ${absoluteInputFile} with esbuild`, start: esbuildStartTime, end: esbuildEndTime, verbose });
  }
  const compileEndTime = performance.now();
  const timeTaken = `${(compileEndTime - compileStartTime).toFixed(2)}ms`
  if (!options?.quiet) {
    console.log(`${inputFile} → ${outputFile} (in ${timeTaken})`);
  }
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

  // Use process.execPath so the child runs under the same Node as the CLI,
  // and pass our resolver shim so the compiled output's `import "agency-lang"`
  // succeeds even when the CLI is installed globally.
  const nodeProcess = spawn(
    process.execPath,
    [...compiledOutputNodeArgs(), output],
    {
      stdio: "inherit",
      shell: false,
      env,
    },
  );

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

function logTime({ label, start, end, verbose }: { label: string, start: number, end: number, verbose: boolean }): void {
  if (verbose) {
    console.log(`${label} in ${(end - start).toFixed(2)}ms`);
  }
}
