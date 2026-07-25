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

/**
 * Run one generator and bring back the `Code` value it produced.
 *
 * The generator runs in a child process, and the parent BLOCKS on it. That
 * is not a preference, it is forced: `_run` (lib/runtime/ipc.ts) is async
 * because it forks, but the whole compile pipeline including
 * `SymbolTable.build` is synchronous, and expansion has to happen inside
 * it. `execFileSync` is what makes an async child usable from a
 * synchronous caller.
 *
 * A child process also buys the two limits this feature needs. A generator
 * that loops forever would otherwise hang the compiler with no way out —
 * the hole Template Haskell has and does not close. Here it becomes an
 * ordinary error message after 30 seconds.
 */

/** Wall clock. A generator does AST manipulation; 30s is enormous for that. */
export const WALL_CLOCK_MS = 30_000;

/** V8 heap ceiling in megabytes, matching `runCode`'s default. */
export const MEMORY_MB = 512;

/** Node named in the synthesized runner. Underscored so it cannot collide
 *  with anything the generator module exports. */
const RUNNER_NODE = "__splice";

/**
 * The limits are overridable so their MECHANISM can be tested without the
 * test paying their real values. A test proving the timeout works should
 * not take 30 seconds; what could plausibly break is the signal handling,
 * not the number.
 */
export type RunGeneratorOptions = {
  config?: AgencyConfig;
  wallClockMs?: number;
  memoryMb?: number;
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
  fs.writeFileSync(runnerPath, runnerSource(splice, generator, tempDir), "utf-8");

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
 * The program that runs the generator: exactly one import and one node.
 *
 * Deliberately NOT the host file's import lines. Copying those was the
 * previous draft's design and it is both leaky and wrong — it drags in
 * every other import the host has, including the npm and `pkg::` imports
 * the eligibility check just banned, and it trips the test-import denial in
 * `resolveImports` when the host uses `import test`.
 *
 * The expression is printed back from the AST rather than sliced out of the
 * source, so what runs is exactly what the parser understood the user to
 * have written.
 */
function runnerSource(
  splice: Splice,
  generator: { modulePath: string; exportedName: string },
  tempDir: string,
): string {
  const local = localName(splice, generator.exportedName);
  const binding =
    local === generator.exportedName
      ? generator.exportedName
      : `${generator.exportedName} as ${local}`;
  const specifier = importSpecifier(tempDir, generator.modulePath);
  return [
    `import { ${binding} } from "${specifier}"`,
    "",
    `export node ${RUNNER_NODE}() {`,
    `  return ${generateExpression(splice.expression)}`,
    "}",
    "",
  ].join("\n");
}

/**
 * What the splice expression calls the generator, which is not necessarily
 * what the module exports it as. `import { makeGetters as gen }` followed
 * by `$( gen(3) )` prints an expression mentioning `gen`, so the runner has
 * to bind that spelling. A splice whose expression is not a plain call
 * falls back to the exported name; the expansion pass rejects those before
 * they reach here, so the fallback is only for safety.
 */
function localName(splice: Splice, exportedName: string): string {
  const expression = splice.expression as { type: string; functionName?: string };
  return expression.type === "functionCall" && expression.functionName !== undefined
    ? expression.functionName
    : exportedName;
}

/** A relative ESM/Agency specifier from `fromDir` to `target`. */
function importSpecifier(fromDir: string, target: string): string {
  const relative = path.relative(fromDir, target).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Compile the runner from a REAL path.
 *
 * `compileSource` cannot do this. It writes source to its own temp dir, so
 * a program importing the generator by relative path cannot resolve it —
 * the generator is not in that directory. Same root cause as the fail-open
 * effect check: anything that needs relative imports to resolve must take a
 * path, never a source string.
 *
 * The typechecker is turned off for this compile. `compileEntry` reports a
 * type error by calling `process.exit(1)`, which would take the user's
 * whole build down with no diagnostic instead of reporting AG8008. The
 * generator module's own types are checked when it is compiled normally.
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

/**
 * The child. It writes to a file rather than stdout because a generator may
 * legitimately print, and a `console.log` in the middle of the payload
 * would corrupt it.
 */
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

/**
 * Run the child under both limits.
 *
 * Which signal came back is the only way to tell the two limits apart, and
 * the obvious field does not work: `err.killed` comes back `undefined` on a
 * timeout kill. `err.signal` is the one that is actually set.
 */
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
  const envelope = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  const data = envelope?.data;

  // A generator rarely crashes the child process, because the runtime
  // converts an exception thrown inside an Agency function into a Failure
  // Result and returns it normally. So the most common way a generator
  // fails arrives here as an ordinary value, and reading the message out of
  // it is the difference between "your generator hit a ReferenceError on
  // line 4" and "it returned an object".
  if (isResultFailure(data)) {
    return {
      ok: false,
      diagnostic: failed(splice, generator, errorText(data.error)),
    };
  }
  const value = isResultSuccess(data) ? data.value : data;

  // An interrupt nobody handled comes back as an Interrupt[] in `data`.
  // That is the backstop behind the static effect check: even if a
  // dangerous operation slipped past eligibility, it cannot complete here,
  // because compilation installs no handlers.
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

/** The Result shapes from `lib/runtime/result.ts`, recognized by their
 *  `__type` tag. Checked here rather than imported because this value
 *  crossed a process boundary as plain JSON and carries no class identity. */
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

/** A Failure's `error` may be a string, an Error-shaped object, or
 *  structured data. Pull out something a person can read. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : JSON.stringify(error);
}

/** Shaped like `lib/runtime/interrupts.ts`'s `Interrupt`, checked loosely
 *  because this value crossed a process boundary as plain JSON. */
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
