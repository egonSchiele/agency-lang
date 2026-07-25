import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { nanoid } from "nanoid";
import { createBuildSession } from "../buildSession.js";
import { RunStrategy } from "../../importStrategy.js";
import { generateExpression } from "../../backends/agencyGenerator.js";
import { isCode } from "../../runtime/template/code.js";
import { safeDeleteDirectory } from "../../utils.js";
import type { Code } from "../../runtime/template/code.js";
import type { AgencyConfig } from "../../config.js";
import type { Splice } from "../../types/splice.js";
import type { SpliceDiagnostic, SpliceResult } from "./types.js";
import type { ImportSource } from "./eligibility.js";

/**
 * Run one generator and bring back the `Code` value it produced.
 *
 * The parent blocks on the child. The compile pipeline is synchronous and
 * expansion happens inside it, so `execFileSync` is the only way to reach
 * an async child from here.
 *
 * The child also gives us the limits. A generator that loops forever
 * becomes an error message instead of a hung compiler.
 */

/** Wall clock. A generator does AST manipulation; 30s is enormous for that. */
export const WALL_CLOCK_MS = 30_000;

/** V8 heap ceiling in megabytes, matching `runCode`'s default. */
export const MEMORY_MB = 512;

/** Node named in the synthesized runner. Underscored so it cannot collide
 *  with anything the generator module exports. */
const RUNNER_NODE = "__splice";

/** Limits are overridable so a test can prove the timeout works without
 *  waiting 30 seconds for it. */
export type RunGeneratorOptions = {
  config?: AgencyConfig;
  wallClockMs?: number;
  memoryMb?: number;
  /** Where each name the splice arguments use comes from. Resolved and
   *  checked by the expansion pass; the specifiers are rewritten here,
   *  because only this file knows where the runner ends up. */
  argumentSources?: ImportSource[];
};

export function runGenerator(
  splice: Splice,
  generator: { modulePath: string; exportedName: string },
  cwd: string,
  options: RunGeneratorOptions = {},
): SpliceResult<Code> {
  const tempDir = path.join(cwd, ".agency-tmp", `splice-${nanoid()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    return runInTempDir(splice, generator, tempDir, options);
  } finally {
    safeDeleteDirectory(tempDir, false);
  }
}

function runInTempDir(
  splice: Splice,
  generator: { modulePath: string; exportedName: string },
  tempDir: string,
  options: RunGeneratorOptions,
): SpliceResult<Code> {
  const runnerPath = path.join(tempDir, "runner.agency");
  fs.writeFileSync(
    runnerPath,
    runnerSource(splice, generator, tempDir, options.argumentSources ?? []),
    "utf-8",
  );

  const compiled = compileRunner(runnerPath, options.config ?? {});
  if (!compiled.ok) {
    return { ok: false, diagnostic: failed(splice, generator, compiled.reason) };
  }

  const resultsPath = path.join(tempDir, "result.json");
  const scriptPath = path.join(tempDir, "run.mjs");
  fs.writeFileSync(
    scriptPath,
    childScript(importSpecifier(tempDir, compiled.outputFile), resultsPath),
    "utf-8",
  );

  const executed = execute(scriptPath, tempDir, options);
  if (!executed.ok) {
    return { ok: false, diagnostic: failed(splice, generator, executed.reason) };
  }

  return readResult(resultsPath, splice, generator);
}

/**
 * The program that runs the generator: the generator's import, whatever
 * the arguments need, and one node.
 *
 * Never copy the host's import lines wholesale. They would drag in the npm
 * and `pkg::` imports the eligibility check just banned. The argument
 * imports are the specific ones the expansion pass resolved and checked.
 */
function runnerSource(
  splice: Splice,
  generator: { modulePath: string; exportedName: string },
  tempDir: string,
  argumentSources: ImportSource[],
): string {
  const local = localName(splice, generator.exportedName);
  const binding =
    local === generator.exportedName
      ? generator.exportedName
      : `${generator.exportedName} as ${local}`;
  const specifier = importSpecifier(tempDir, generator.modulePath);
  return [
    `import { ${binding} } from "${specifier}"`,
    ...argumentSources.map((source) => argumentImportLine(source, tempDir)),
    "",
    `export node ${RUNNER_NODE}() {`,
    `  return ${generateExpression(splice.expression)}`,
    "}",
    "",
  ].join("\n");
}

/**
 * What the splice calls the generator, which may differ from what the
 * module exports. After `import { makeGetters as gen }`, the printed
 * expression says `gen`, so the runner has to bind that spelling.
 */
function localName(splice: Splice, exportedName: string): string {
  const expression = splice.expression as { type: string; functionName?: string };
  return expression.type === "functionCall" && expression.functionName !== undefined
    ? expression.functionName
    : exportedName;
}

/**
 * One import line for a name an argument uses.
 *
 * A file specifier is rewritten relative to the runner's own directory,
 * since the host's `./data.agency` does not resolve from a temp dir. A
 * `std::` specifier is already absolute in Agency's terms and passes
 * through.
 */
function argumentImportLine(source: ImportSource, tempDir: string): string {
  const specifier =
    source.modulePath === null
      ? source.specifier
      : importSpecifier(tempDir, source.modulePath);
  const binding =
    source.exportedName === source.localName
      ? source.exportedName
      : `${source.exportedName} as ${source.localName}`;
  return `import { ${binding} } from "${specifier}"`;
}

/** A relative ESM/Agency specifier from `fromDir` to `target`. */
function importSpecifier(fromDir: string, target: string): string {
  const relative = path.relative(fromDir, target).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Compile the runner from a real path. `compileSource` writes to its own
 * temp dir, where the generator's relative import cannot resolve.
 *
 * The typechecker is off here because `compileEntry` reports a type error
 * with `process.exit(1)`, which would kill the user's build instead of
 * reporting AG8008.
 */
function compileRunner(
  runnerPath: string,
  config: AgencyConfig,
): { ok: true; outputFile: string } | { ok: false; reason: string } {
  try {
    const outputFile = createBuildSession().compile(
      { ...config, typechecker: { enabled: false } },
      {
        entries: [runnerPath],
        importStrategy: new RunStrategy(),
        quiet: true,
      },
    );
    if (outputFile === null) {
      return { ok: false, reason: "the generator module could not be compiled" };
    }
    return { ok: true, outputFile };
  } catch (err) {
    return { ok: false, reason: messageOf(err) };
  }
}

/** The child writes to a file, not stdout: a generator may print, and that
 *  would corrupt the payload. */
function childScript(moduleSpecifier: string, resultsPath: string): string {
  return [
    `import { ${RUNNER_NODE} } from ${JSON.stringify(moduleSpecifier)};`,
    `import { writeFileSync } from "node:fs";`,
    ``,
    `const result = await ${RUNNER_NODE}();`,
    `writeFileSync(${JSON.stringify(resultsPath)}, JSON.stringify(result));`,
    ``,
  ].join("\n");
}

/** Run the child under both limits. Read `err.signal` to tell them apart.
 *  `err.killed` is `undefined` even on a timeout kill. */
function execute(
  scriptPath: string,
  cwd: string,
  options: RunGeneratorOptions,
): { ok: true } | { ok: false; reason: string } {
  const wallClockMs = options.wallClockMs ?? WALL_CLOCK_MS;
  const memoryMb = options.memoryMb ?? MEMORY_MB;
  try {
    execFileSync("node", [`--max-old-space-size=${memoryMb}`, scriptPath], {
      timeout: wallClockMs,
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { ok: true };
  } catch (err) {
    const signal = (err as { signal?: string }).signal;
    if (signal === "SIGTERM") {
      return {
        ok: false,
        reason: `it did not finish within ${wallClockMs / 1000} seconds`,
      };
    }
    if (signal === "SIGABRT") {
      return { ok: false, reason: `it exceeded the ${memoryMb}mb memory limit` };
    }
    return { ok: false, reason: stderrOf(err) };
  }
}

/** Read back what the child wrote, and refuse anything that is not `Code`. */
function readResult(
  resultsPath: string,
  splice: Splice,
  generator: { modulePath: string; exportedName: string },
): SpliceResult<Code> {
  if (!fs.existsSync(resultsPath)) {
    return {
      ok: false,
      diagnostic: failed(splice, generator, "it produced no result"),
    };
  }
  // A node returns an envelope, not the value: `{ messages, data, tokens }`.
  // The generator's own return value is under `data`.
  //
  // Parsing can fail on a partially flushed file: a large payload being
  // written when the wall-clock SIGTERM lands leaves valid-looking bytes
  // that `existsSync` accepts and `JSON.parse` rejects.
  let envelope: { data?: unknown };
  try {
    envelope = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  } catch {
    return {
      ok: false,
      diagnostic: failed(splice, generator, "it produced an unreadable result"),
    };
  }
  const data = envelope?.data;

  // A generator rarely crashes the child. The runtime turns an exception
  // inside an Agency function into a Failure Result and returns it
  // normally, so the usual failure arrives here as an ordinary value.
  if (isResultFailure(data)) {
    return {
      ok: false,
      diagnostic: failed(splice, generator, errorText(data.error)),
    };
  }
  const value = isResultSuccess(data) ? data.value : data;

  // An unhandled interrupt comes back as an Interrupt[]. This backs up the
  // static effect check: compilation installs no handlers, so a dangerous
  // operation cannot complete even if it slipped past eligibility.
  if (isInterruptList(value)) {
    return {
      ok: false,
      diagnostic: failed(
        splice,
        generator,
        `it raised ${interruptNames(value)}, which cannot be handled at compile time`,
      ),
    };
  }
  if (!isCode(value)) {
    return {
      ok: false,
      diagnostic: failed(
        splice,
        generator,
        `it returned ${describe(value)} rather than a Code value`,
      ),
    };
  }
  return { ok: true, value };
}

/** The Result shapes from `lib/runtime/result.ts`. Matched on the `__type`
 *  tag because this value arrived as plain JSON. */
function isResultFailure(value: unknown): value is { error: unknown } {
  return isTagged(value) && value.success === false;
}

function isResultSuccess(value: unknown): value is { value: unknown } {
  return isTagged(value) && value.success === true;
}

function isTagged(value: unknown): value is { success: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __type?: unknown }).__type === "resultType"
  );
}

/** Pull something readable out of a Failure's `error`, whatever shape it
 *  arrived in. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : JSON.stringify(error);
}

/** Shaped like `Interrupt` in `lib/runtime/interrupts.ts`, checked loosely
 *  because this arrived as plain JSON. */
function isInterruptList(value: unknown): value is Array<{ name?: string }> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string",
    )
  );
}

function interruptNames(interrupts: Array<{ name?: string }>): string {
  const names = interrupts.map((item) => item.name ?? "an interrupt");
  return names.filter((name, index) => names.indexOf(name) === index).join(", ");
}

/** A short, non-leaking description of an unexpected return value. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

function failed(
  splice: Splice,
  generator: { modulePath: string; exportedName: string },
  reason: string,
): SpliceDiagnostic {
  return {
    diagnostic: "spliceGeneratorFailed",
    params: { name: generator.exportedName, reason },
    loc: splice.loc ?? { line: 0, col: 0, start: 0, end: 0 },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What the child said before it died. Node puts the child's stderr on the
 * error object, and that is the only place the generator's own error
 * message exists — the exception the parent sees says nothing but "Command
 * failed".
 */
function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: string | Buffer }).stderr;
  const text = typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
  const trimmed = text.trim();
  return trimmed === "" ? messageOf(err) : trimmed;
}
