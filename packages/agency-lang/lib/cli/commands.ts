import { generateAgency } from "@/backends/agencyGenerator.js";
import {
  AgencyConfig,
  CONFIG_OVERRIDES_ENV,
  loadConfigSafe,
  mergeConfigOverrides,
  readConfigOverrides,
  serializeConfigOverrides,
  TRACE_ID_ENV,
} from "@/config.js";
import { withCodeIdentity } from "@/runDirectory/codeIdentity.js";
import { wrapTracesAsRunDirectories } from "@/runDirectory/mutations.js";
import { AgencyProgram } from "@/index.js";
import { spawn } from "child_process";
import * as fs from "fs";
import { createRequire } from "module";
import { nanoid } from "nanoid";
import * as os from "os";
import * as path from "path";

import { RunStrategy } from "../importStrategy.js";
import { compileAgencyOnly } from "../compiler/compileSandboxed.js";
import { withRootCarriers } from "./childEnv.js";
import {} from "@/constants.js";
import { parseAgency, replaceBlankLines } from "../parser.js";
import { fileURLToPath, pathToFileURL } from "url";
import { classifyInstall, installDirFromUrl, type InstallKind } from "./installLocation.js";
import { findRecursively } from "@/utils/findRecursively.js";
import { readFile } from "../compiler/buildSession.js";
import { compile } from "../compiler/defaultSession.js";

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
  return pathToFileURL(path.join(thisDir, "runShim", "register.mjs")).href;
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
  const dir =
    fs.existsSync(outputContext) && fs.statSync(outputContext).isDirectory()
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
export function loadConfig(configPath?: string, verbose: boolean = false): AgencyConfig {
  const finalConfigPath = configPath || path.join(process.cwd(), "agency.json");

  // Diagnostics go to stderr so they never contaminate a command's
  // machine-consumed stdout (e.g. `remote logs --json`).
  if (verbose) {
    console.error(`Looking for config at: ${finalConfigPath}`);
  }

  const { config, error } = loadConfigSafe(finalConfigPath);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  if (config.verbose) {
    console.error(`Loaded config from ${finalConfigPath}`);
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

export async function format(contents: string, config: AgencyConfig = {}): Promise<string> {
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
  budget?: { maxCost?: string; maxTime?: string },
  /** Forwarded to the compiled program's argv (positions 2+), for the program
   *  itself to read — `std::args` is how. They are NOT mapped onto the entry
   *  node's parameters, which receive `undefined` on this path. */
  nodeArgs: string[] = [],
  /** `--capture-workdir <dir>`: after the run, write its statelog, code and a
   *  snapshot of the working directory as the run directory `<dir>/<traceId>/`. */
  capture?: { runDir: string },
  compileMode: { agencyOnly: boolean } = { agencyOnly: false },
): void {
  let output: string;
  if (compileMode.agencyOnly) {
    const compiled = compileAgencyOnly(inputFile);
    if (!compiled.ok) {
      console.error("Error: agency-only compile refused:");
      for (const error of compiled.errors) console.error(`  ${error}`);
      process.exit(1);
    }
    output = compiled.scriptPath;
  } else {
    const compiledOutput = compile(config, inputFile, outputFile, {
      importStrategy: new RunStrategy(),
    });
    if (compiledOutput === null) {
      console.error("Error: No output file generated.");
      process.exit(1);
    }
    output = compiledOutput;
  }

  console.log(`Running ${output}...`);
  console.log("---");

  const env = withRootCarriers(process.env, { policy: runPolicy, budget });
  const captured = capture === undefined ? undefined : prepareCapture(capture.runDir);
  env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides(
    runChildOverrides({
      inherited: readConfigOverrides(env),
      captureStatelogFile: captured?.statelogFile,
      inputFile,
    }),
  );
  if (captured !== undefined) env[TRACE_ID_ENV] = captured.traceId;
  if (resumeFile) env.AGENCY_RESUME_FILE = resumeFile;

  // Use process.execPath so the child runs under the same Node as the CLI,
  // and pass our resolver shim so the compiled output's `import "agency-lang"`
  // succeeds even when the CLI is installed globally.
  const nodeProcess = spawn(process.execPath, [...compiledOutputNodeArgs(), output, ...nodeArgs], {
    stdio: "inherit",
    shell: false,
    env,
  });

  nodeProcess.on("error", (error) => {
    console.error(`Failed to run ${output}:`, error);
    process.exit(1);
  });

  nodeProcess.on("exit", (code) => {
    if (captured !== undefined) {
      try {
        finishCapture(captured, inputFile);
      } catch (error) {
        console.error(`Error: could not capture the run: ${(error as Error).message}`);
        process.exit(1);
      }
    }
    if (code !== 0) {
      process.exit(code || 1);
    }
  });
}

/**
 * The config overrides `agency run` hands its child. Inherited overrides are
 * kept (an eval harness hands this process its statelog path the same way),
 * but two things always win over them: the capture statelog when
 * `--capture-workdir` asked for one (the child MUST write there, or there is
 * nothing to fold in), and the identity of THIS file (a trace must never name
 * another program, whatever `log.code` a parent or stale shell left behind).
 */
export function runChildOverrides(args: {
  inherited: Partial<AgencyConfig>;
  captureStatelogFile?: string;
  inputFile: string;
}): Partial<AgencyConfig> {
  const captureOverrides: Partial<AgencyConfig> =
    args.captureStatelogFile === undefined
      ? {}
      : { observability: true, log: { logFile: args.captureStatelogFile } };
  return withCodeIdentity(mergeConfigOverrides(args.inherited, captureOverrides), args.inputFile);
}

type Capture = {
  /** The group directory the run directory is written into. */
  groupDir: string;
  traceId: string;
  statelogFile: string;
  /** A fresh, empty directory this process created under the OS temp dir. It
   *  holds only the staged statelog and is removed when the capture ends. */
  captureTempDir: string;
};

/** A fresh trace id and a private statelog file for this run, so the fold
 *  into the run directory sees exactly this run's events. */
function prepareCapture(groupDir: string): Capture {
  const traceId = nanoid();
  const captureTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-capture-"));
  return {
    groupDir,
    traceId,
    statelogFile: path.join(captureTempDir, "statelog.jsonl"),
    captureTempDir,
  };
}

/** One run directory at `<group>/<traceId>/`: the staged statelog, the code
 *  that ran, and the working directory as its workdir snapshot (the group
 *  itself left out of the snapshot when it sits inside the working directory).
 *  The temp dir goes whether or not the write succeeded. */
function finishCapture(capture: Capture, inputFile: string): void {
  let written: string[];
  try {
    if (!fs.existsSync(capture.statelogFile)) {
      throw new Error(`the run wrote no statelog at ${capture.statelogFile}`);
    }
    written = wrapTracesAsRunDirectories(
      {
        groupDir: capture.groupDir,
        statelogFiles: [capture.statelogFile],
        codeEntries: [inputFile],
        annotationFiles: [],
        workdir: { sourceDir: process.cwd(), excludeDir: capture.groupDir },
      },
      { reportWarning: (message) => console.warn(message) },
    ).written;
  } finally {
    removeCaptureTempDir(capture.captureTempDir);
  }
  console.log(`---
Captured trace ${capture.traceId} into ${written[0] ?? capture.groupDir}`);
}

/** Only ever removes the mkdtemp directory prepareCapture made: it must sit
 *  directly under the OS temp dir and carry the capture prefix. */
function removeCaptureTempDir(captureTempDir: string): void {
  const resolved = path.resolve(captureTempDir);
  const underTemp = path.dirname(resolved) === path.resolve(os.tmpdir());
  if (!underTemp || !path.basename(resolved).startsWith("agency-capture-")) {
    console.warn(`Not removing ${captureTempDir}: it is not a capture temp directory.`);
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
