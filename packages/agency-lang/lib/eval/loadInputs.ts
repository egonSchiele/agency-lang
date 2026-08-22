import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import { assertEvalInputId } from "./ids.js";
import type { AgencyTestDefinition, AgencyTestVisibility, Test } from "./runTypes.js";
import { parseSource, resolveSource } from "./sources.js";

type MakeId = () => string;

/** Loader options. `requireGoal` defaults to true (the default goal-judge needs
 *  a goal); a custom grading module may not, so the optimize CLI passes false. */
type LoadOptions = {
  requireGoal?: boolean;
  /** One-level nesting rule: set when the suite itself came from a git source. */
  forbidGitFiles?: boolean;
  /** Caller-supplied accumulator: test id → where its `files` came from. */
  filesProvenance?: Record<string, { source: string; sha?: string }>;
  /** Cache root override for git sources (tests; config.eval.sourceCacheRoot). */
  sourceCacheRoot?: string;
};

/** The `eval run` one-off test: `--input <text>` gives it that input, no
 *  `--input` gives it none (for agents that take no argument). It carries no
 *  goal either way; `eval grade --goal` supplies one at grading time. */
export function inlineInput(input: string | undefined): Test {
  if (input === undefined) return { id: "input-1" };
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("--input must be a non-empty string");
  }
  return { id: "input-1", input };
}

export function loadInputs(
  sourcePath: string,
  makeId: MakeId = nanoid,
  options: LoadOptions = {},
): Test[] {
  const stat = fs.statSync(sourcePath);
  const inputs = stat.isDirectory()
    ? loadInputsFromDirectory(sourcePath, makeId, options)
    : loadInputsFromFile(sourcePath, makeId, options);
  // An empty suite is a mistake (wrong path, empty file), never a run:
  // zero inputs would "succeed" with objective 0 and hide the mistake —
  // and under `optimize` it would burn the whole iteration budget
  // grading candidates against nothing.
  if (inputs.length === 0) {
    throw new Error(`no inputs loaded from ${sourcePath}`);
  }
  return inputs;
}

export function loadInputsFromFile(
  filePath: string,
  makeId: MakeId = nanoid,
  options: LoadOptions = {},
): Test[] {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).inputs)) {
    throw new Error(`Test suite ${filePath} must contain a top-level inputs array`);
  }
  return validateInputs(
    (parsed as any).inputs.map((raw: unknown) =>
      normalizeInput(raw, path.dirname(filePath), makeId, options),
    ),
  );
}

/** A parsed json file whose top-level shape is the suite-file wrapper. */
function isWrapperFile(filePath: string): boolean {
  const parsed = readJson(filePath);
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).inputs)
  );
}

function loadInputsFromDirectory(
  directoryPath: string,
  makeId: MakeId,
  options: LoadOptions,
): Test[] {
  // A directory that itself contains test.json IS a single test — pointing
  // --inputs at one test of a suite must keep the test-directory sugar
  // (id from the directory name, files/, graders.ts auto-discovery).
  if (fs.existsSync(path.join(directoryPath, "test.json"))) {
    return validateInputs([loadTestDir(directoryPath, makeId, options)]);
  }
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const testDirs = entries
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(directoryPath, entry.name, "test.json")),
    )
    .map((entry) => entry.name)
    .sort();
  const wrapperFiles = jsonFiles.filter((name) => isWrapperFile(path.join(directoryPath, name)));
  const looseFiles = jsonFiles.filter((name) => !wrapperFiles.includes(name));

  const shapes = [wrapperFiles, looseFiles, testDirs].filter((group) => group.length > 0);
  if (shapes.length > 1) {
    throw new Error(
      `Test directory ${directoryPath} mixes suite shapes ` +
        `(${shapes.map((group) => group[0]).join(", ")}). Use one form per directory: ` +
        `a single inputs file with an "inputs" array, one-input .json files, or test directories.`,
    );
  }
  if (wrapperFiles.length > 1) {
    throw new Error(
      `Test directory ${directoryPath} has multiple suite files: ${wrapperFiles.join(", ")}`,
    );
  }
  if (wrapperFiles.length === 1) {
    return loadInputsFromFile(path.join(directoryPath, wrapperFiles[0]), makeId, options);
  }
  if (testDirs.length > 0) {
    return validateInputs(
      testDirs.map((name) => loadTestDir(path.join(directoryPath, name), makeId, options)),
    );
  }
  return validateInputs(
    looseFiles.map((name) =>
      normalizeInput(readJson(path.join(directoryPath, name)), directoryPath, makeId, options),
    ),
  );
}

/** The heavy form: test.json beside an optional files/ directory and an
 *  optional graders.ts. Desugars to the same Test the light form produces —
 *  id defaults to the directory name, files to the sibling files/, graders
 *  to the sibling graders.ts. */
function loadTestDir(testDir: string, makeId: MakeId, options: LoadOptions): Test {
  const raw = readJson(path.join(testDir, "test.json"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path.join(testDir, "test.json")} must contain a JSON object`);
  }
  const spec = { ...(raw as Record<string, unknown>) };
  if (spec.id === undefined) {
    spec.id = path.basename(testDir);
  }
  if (spec.files === undefined && fs.existsSync(path.join(testDir, "files"))) {
    spec.files = "./files";
  }
  if (spec.graders === undefined && fs.existsSync(path.join(testDir, "graders.ts"))) {
    spec.graders = "./graders.ts";
  }
  const agencyTests = discoverAgencyTests(testDir);
  // A test graded by discovered agency tests needs no goal of its own.
  const testOptions = agencyTests.length > 0 ? { ...options, requireGoal: false } : options;
  const test = normalizeInput(spec, testDir, makeId, testOptions);
  if (agencyTests.length > 0) {
    test.agencyTests = agencyTests;
  }
  return test;
}

/** Directory-convention discovery: every *.test.json directly inside
 *  `files/` (seeded, visible to the agent) and `holdout/` (never seeded)
 *  becomes one grader, named by basename. Non-recursive by design — a
 *  nested .test.json is the agent's own business. Each json needs its
 *  sibling harness `.agency`; basenames must be unique across the union
 *  (they become score-row names). */
function discoverAgencyTests(testDir: string): AgencyTestDefinition[] {
  const found: AgencyTestDefinition[] = [];
  const byName: Record<string, string> = Object.create(null);
  const dirs: { sub: string; visibility: AgencyTestVisibility }[] = [
    { sub: "files", visibility: "visible" },
    { sub: "holdout", visibility: "holdout" },
  ];
  for (const { sub, visibility } of dirs) {
    const dir = path.join(testDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith(".test.json")) continue;
      const harnessJson = path.join(dir, entry);
      const name = entry.replace(/\.test\.json$/, "");
      const harnessAgency = path.join(dir, `${name}.agency`);
      if (!fs.existsSync(harnessAgency)) {
        throw new Error(
          `${harnessJson} has no sibling harness ${name}.agency — eval agency tests are ` +
            `discovered as sibling pairs`,
        );
      }
      if (byName[name] !== undefined) {
        throw new Error(
          `agency-test name '${name}' appears twice: ${byName[name]} and ${harnessJson}. ` +
            `Basenames become grader names and must be unique across files/ and holdout/.`,
        );
      }
      byName[name] = harnessJson;
      found.push({ harnessJson, harnessAgency, name, visibility });
    }
  }
  return found;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to read input JSON ${filePath}: ${(err as Error).message}`);
  }
}

function normalizeInput(raw: unknown, baseDir: string, makeId: MakeId, options: LoadOptions): Test {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Eval input must be a JSON object");
  }
  const spec = raw as Record<string, unknown>;
  if (spec.task !== undefined) {
    throw new Error(
      '"task" was renamed to "input": put what the agent is given in "input" ' +
        "(a string or a JSON object).",
    );
  }
  if (spec.args !== undefined || spec.node !== undefined) {
    throw new Error(
      'Eval tests do not take "args" or "node" — tests describe the input, not the agent. ' +
        'Put what the agent is given in "input" (a string or a JSON object); ' +
        "pick the node with --agent file.agency:node.",
    );
  }
  if (spec.goal !== undefined && spec.rubric !== undefined) {
    throw new Error("Eval input cannot specify both goal and rubric");
  }
  // A goal is only required where the default LLM judge would actually run —
  // an input carrying its own graders grades itself.
  const requireGoal = (options.requireGoal ?? true) && spec.graders === undefined;
  if (requireGoal && (typeof spec.goal !== "string" || spec.goal.length === 0)) {
    throw new Error("Eval input goal must be a non-empty string");
  }
  if (spec.goal !== undefined && typeof spec.goal !== "string") {
    throw new Error("Eval input goal must be a string when provided");
  }
  if (spec.input !== undefined && typeof spec.input !== "string" && !isPlainObject(spec.input)) {
    throw new Error(
      "Eval test input must be a string, or a JSON object for structured input (or omitted for an agent that takes none)",
    );
  }
  if (typeof spec.input === "string" && spec.input.length === 0) {
    throw new Error(
      'Eval test input must not be an empty string; omit "input" (or give {}) for an agent that takes none',
    );
  }
  if (spec.files !== undefined && typeof spec.files !== "string") {
    throw new Error("Eval input files must be a string when provided");
  }
  if (spec.graders !== undefined && typeof spec.graders !== "string") {
    throw new Error("Eval input graders must be a path string when provided");
  }
  if (
    spec.timeoutSec !== undefined &&
    (typeof spec.timeoutSec !== "number" ||
      !Number.isFinite(spec.timeoutSec) ||
      spec.timeoutSec <= 0)
  ) {
    throw new Error("Eval input timeoutSec must be a positive number of seconds when provided");
  }
  if (spec.metadata !== undefined && !isPlainObject(spec.metadata)) {
    throw new Error("Eval input metadata must be an object when provided");
  }
  if (
    spec.description !== undefined &&
    (typeof spec.description !== "string" || spec.description.length === 0)
  ) {
    throw new Error("Eval input description must be a non-empty string when provided");
  }
  if (
    spec.tags !== undefined &&
    (!Array.isArray(spec.tags) ||
      spec.tags.some((tag) => typeof tag !== "string" || tag.length === 0))
  ) {
    throw new Error("Eval input tags must be an array of non-empty strings when provided");
  }
  const out: Test = {
    id: typeof spec.id === "string" ? spec.id : makeId(),
    expected: spec.expected, // any JSON; absent stays undefined
  };
  // `{}` is the suite's way of saying "no input", like `eval run` without --input.
  const hasInput =
    spec.input !== undefined &&
    !(isPlainObject(spec.input) && Object.keys(spec.input).length === 0);
  if (hasInput) out.input = spec.input as string | Record<string, any>;
  if (typeof spec.description === "string") out.description = spec.description;
  if (Array.isArray(spec.tags)) out.tags = spec.tags as string[];
  if (typeof spec.goal === "string") out.goal = spec.goal;
  if (typeof spec.files === "string")
    out.files = resolveFilesDir(spec.files, baseDir, options, out.id ?? "");
  if (typeof spec.graders === "string")
    out.graders = resolveGradersFile(spec.graders, baseDir, out.id ?? "");
  if (typeof spec.timeoutSec === "number") out.timeoutSec = spec.timeoutSec;
  if (isPlainObject(spec.metadata)) out.metadata = spec.metadata as Record<string, any>;
  return out;
}

/** Resolve a files entry — a local directory or a git source — to an absolute
 *  directory, recording provenance when the caller collects it. */
function resolveFilesDir(
  raw: string,
  baseDir: string,
  options: LoadOptions,
  inputId: string,
): string {
  const parsed = parseSource(raw, baseDir);
  if (parsed.kind === "git") {
    if (options.forbidGitFiles) {
      throw new Error(
        `Test ${inputId}: files "${raw}" is a git source, but this suite was itself loaded from git. ` +
          `Sources resolve one level deep — vendor the fixtures into the suite repo instead.`,
      );
    }
    const resolved = resolveSource(parsed, { cacheRoot: options.sourceCacheRoot });
    if (options.filesProvenance) {
      options.filesProvenance[inputId] = { source: raw, sha: resolved.sha };
    }
    return resolved.dir;
  }
  if (!fs.existsSync(parsed.path) || !fs.statSync(parsed.path).isDirectory()) {
    throw new Error(
      `Eval input files must name a directory (got ${raw}, resolved to ${parsed.path})`,
    );
  }
  if (options.filesProvenance) {
    options.filesProvenance[inputId] = { source: raw };
  }
  return fs.realpathSync(parsed.path);
}

/** Resolve an input's grading module to an absolute file path. Graders are
 *  code the harness executes — a suite that ships one is trusted by virtue
 *  of being run, remote git sources included. */
function resolveGradersFile(raw: string, baseDir: string, inputId: string): string {
  const abs = path.resolve(baseDir, raw);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(
      `Test ${inputId}: graders must name a TypeScript file (got ${raw}, resolved to ${abs})`,
    );
  }
  return abs;
}

/** A non-null, non-array object — the shape `args`/`metadata` must have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInputs(inputs: Test[]): Test[] {
  // Null-prototype: ids are user-controlled and the id charset allows names
  // like "__proto__" and "constructor", which on a plain object hit inherited
  // members ("constructor" would be a false duplicate; "__proto__" cannot be
  // recorded at all). Same precedent as EvalCache.
  const seen: Record<string, true> = Object.create(null);
  for (const input of inputs) {
    const id = input.id ?? "";
    assertEvalInputId(id);
    if (seen[id]) {
      throw new Error(`Duplicate id "${id}"`);
    }
    seen[id] = true;
  }
  return inputs;
}
