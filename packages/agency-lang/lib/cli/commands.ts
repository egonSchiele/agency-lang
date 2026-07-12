import { generateAgency } from "@/backends/agencyGenerator.js";
import { AgencyConfig, loadConfigSafe } from "@/config.js";
import { AgencyProgram } from "@/index.js";
import { spawn } from "child_process";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";

import { RunStrategy } from "../importStrategy.js";
import {
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_RUN_POLICY_INTERACTIVE_ON,
} from "@/constants.js";
import { parseAgency, replaceBlankLines } from "../parser.js";
import { fileURLToPath, pathToFileURL } from "url";
import {
  classifyInstall,
  installDirFromUrl,
  type InstallKind,
} from "./installLocation.js";
import { findRecursively } from "./util.js";
import {
  createBuildSession,
  readFile,
  type BuildSession,
  type CompileOptions,
} from "../compiler/buildSession.js";

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

export type InputSource = { kind: "file"; path: string } | { kind: "stdin" };

/**
 * Turn raw CLI arguments into an ordered list of input sources.
 * - no arguments   -> a single stdin source
 * - "-"            -> a stdin source (mixable with files/dirs)
 * - a directory    -> every .agency file under it (recursive)
 * - a file         -> that file
 * - a missing path -> prints an error and exits 1
 * - a second stdin -> prints an error and exits 1 (stdin is read-once)
 *
 * Returns null (after printing a notice to stderr) when arguments were given
 * but no .agency files were found, so the caller can exit cleanly instead of
 * hanging on stdin. The notice goes to stderr, not stdout, so it never
 * corrupts a command's machine-consumed output (e.g. `diagnostics` JSON).
 */
export function resolveInputSources(inputs: string[]): InputSource[] | null {
  if (inputs.length === 0) {
    return [{ kind: "stdin" }];
  }
  const sources: InputSource[] = [];
  let sawStdin = false;
  for (const input of inputs) {
    if (input === "-") {
      if (sawStdin) {
        console.error("Error: stdin ('-') can only be read once");
        process.exit(1);
      }
      sawStdin = true;
      sources.push({ kind: "stdin" });
      continue;
    }
    if (!fs.existsSync(input)) {
      console.error(`Error: Input file '${input}' not found`);
      process.exit(1);
    }
    if (fs.statSync(input).isDirectory()) {
      for (const { path: filePath } of findRecursively(input)) {
        sources.push({ kind: "file", path: filePath });
      }
    } else {
      sources.push({ kind: "file", path: input });
    }
  }
  if (sources.length === 0) {
    console.error("No .agency files found in the given input(s).");
    return null;
  }
  return sources;
}

export async function readSource(src: InputSource): Promise<string> {
  return src.kind === "stdin" ? readStdin() : readFile(src.path);
}

/**
 * Resolve `inputs` to sources, then read and hand each to `handle`. Returns
 * early (no-op) when `resolveInputSources` returns null (arguments given but
 * no .agency files found). This is the shared "iterate every input" scaffold
 * for commands that process each source independently. typecheck does NOT use
 * it — it needs the whole resolved list up front to seed one SymbolTable.
 */
export async function forEachSource(
  inputs: string[],
  handle: (contents: string, src: InputSource) => void | Promise<void>,
): Promise<void> {
  const sources = resolveInputSources(inputs);
  if (sources === null) {
    return;
  }
  for (const src of sources) {
    await handle(await readSource(src), src);
  }
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

export { readFile };

// The default session backing the legacy module-level entry points
// (compile/compileMany/resetCompilationCache). Deliberately the ONLY
// compile-pipeline state left in this file: CLI processes are
// single-session by nature, and watch mode resets it between rebuilds.
// All pipeline logic lives in lib/compiler/buildSession.ts.
//
// Created LAZILY, not at module top level: `agency pack` bundles compiled
// programs whose import chain reaches this module for small helpers
// (readFile, loadConfig). An eager createBuildSession() call is a
// top-level side effect that defeats esbuild tree-shaking and drags the
// entire codegen subtree into every packed artifact (~16k extra lines,
// caught by pack.test.ts).
let defaultSession: BuildSession | null = null;

function getDefaultSession(): BuildSession {
  return (defaultSession ??= createBuildSession());
}

export function resetCompilationCache(): void {
  defaultSession = null;
}

/**
 * Compile a set of entry files under ONE union closure, like the
 * directory branch of `compile()` does. Callers with many entry points
 * (the test runner's precompile pass) use this instead of per-file
 * `compile()` calls, which would rebuild the closure once per entry.
 *
 * Unlike the CLI directory branch, closure errors THROW
 * (`CompileClosureError`) instead of exiting, so programmatic callers
 * can attach context. Parse/typecheck failures inside per-file
 * `compile()` keep their existing exit behavior.
 */
export function compileMany(
  config: AgencyConfig,
  files: string[],
  options?: {
    quiet?: boolean;
    allowTestImports?: boolean;
  },
): void {
  getDefaultSession().compile(config, { entries: files, ...options });
}

/**
 * Compile an .agency file (or directory of them) to JavaScript. Thin
 * delegate over the default BuildSession — all pipeline logic and caching
 * state live in lib/compiler/buildSession.ts.
 */
export function compile(
  config: AgencyConfig,
  inputFile: string,
  _outputFile?: string,
  options?: CompileOptions,
): string | null {
  return getDefaultSession().compile(config, {
    entries: [inputFile],
    outputFile: _outputFile,
    ...options,
  });
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
  runPolicy?: { policyJson: string; interactive: boolean },
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
  if (resumeFile) env.AGENCY_RESUME_FILE = resumeFile;
  // Make the child's policy behavior fully determined by THIS run's flags — never
  // by a stray AGENCY_RUN_POLICY* inherited from the parent shell or an outer run
  // (e.g. a leftover ...INTERACTIVE=1 would otherwise silently enable prompting).
  delete env[AGENCY_RUN_POLICY];
  delete env[AGENCY_RUN_POLICY_INTERACTIVE];
  if (runPolicy) {
    env[AGENCY_RUN_POLICY] = runPolicy.policyJson;
    if (runPolicy.interactive) {
      env[AGENCY_RUN_POLICY_INTERACTIVE] = AGENCY_RUN_POLICY_INTERACTIVE_ON;
    }
  }

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
