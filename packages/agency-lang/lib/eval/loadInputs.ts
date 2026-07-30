import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import { assertEvalInputId } from "./ids.js";
import type { SourceProvenance } from "./runArtifacts.js";
import type { Input } from "./runTypes.js";
import { parseSource, resolveSource } from "./sources.js";

type MakeId = () => string;

/** Loader options. `requireGoal` defaults to true (the default goal-judge needs
 *  a goal); a custom grading module may not, so the optimize CLI passes false. */
type LoadOptions = {
  requireGoal?: boolean;
  /** One-level nesting rule: set when the suite itself came from a git source. */
  forbidGitFiles?: boolean;
  /** Caller-supplied accumulator: input id → files source provenance. */
  filesProvenance?: Record<string, SourceProvenance>;
  /** Cache root override for git sources (tests; config.eval.sourceCacheRoot). */
  sourceCacheRoot?: string;
};

export function inputFromGoal(goal: string): Input {
  if (typeof goal !== "string" || goal.length === 0) {
    throw new Error("--goal must be a non-empty string");
  }
  return { id: "input-1", goal, args: {} };
}

export function loadInputs(sourcePath: string, makeId: MakeId = nanoid, options: LoadOptions = {}): Input[] {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    return loadInputsFromDirectory(sourcePath, makeId, options);
  }
  return loadInputsFromFile(sourcePath, makeId, options);
}

export function loadInputsFromFile(filePath: string, makeId: MakeId = nanoid, options: LoadOptions = {}): Input[] {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).inputs)) {
    throw new Error(`Input suite ${filePath} must contain a top-level inputs array`);
  }
  return validateInputs(
    (parsed as any).inputs.map((raw: unknown) => normalizeInput(raw, path.dirname(filePath), makeId, options)),
  );
}

/** A parsed json file whose top-level shape is the suite-file wrapper. */
function isWrapperFile(filePath: string): boolean {
  const parsed = readJson(filePath);
  return typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).inputs);
}

function loadInputsFromDirectory(directoryPath: string, makeId: MakeId, options: LoadOptions): Input[] {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort();
  const testDirs = entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directoryPath, entry.name, "test.json")))
    .map((entry) => entry.name)
    .sort();
  const wrapperFiles = jsonFiles.filter((name) => isWrapperFile(path.join(directoryPath, name)));
  const looseFiles = jsonFiles.filter((name) => !wrapperFiles.includes(name));

  const shapes = [wrapperFiles, looseFiles, testDirs].filter((group) => group.length > 0);
  if (shapes.length > 1) {
    throw new Error(
      `Input directory ${directoryPath} mixes suite shapes ` +
      `(${shapes.map((group) => group[0]).join(", ")}). Use one form per directory: ` +
      `a single inputs file with an "inputs" array, one-input .json files, or test directories.`,
    );
  }
  if (wrapperFiles.length > 1) {
    throw new Error(`Input directory ${directoryPath} has multiple suite files: ${wrapperFiles.join(", ")}`);
  }
  if (wrapperFiles.length === 1) {
    return loadInputsFromFile(path.join(directoryPath, wrapperFiles[0]), makeId, options);
  }
  if (testDirs.length > 0) {
    return validateInputs(testDirs.map((name) => loadTestDir(path.join(directoryPath, name), makeId, options)));
  }
  return validateInputs(
    looseFiles.map((name) => normalizeInput(readJson(path.join(directoryPath, name)), directoryPath, makeId, options)),
  );
}

/** The heavy form: test.json beside an optional files/ directory. Desugars to
 *  the same Input the light form produces — id defaults to the directory
 *  name, files to the sibling files/. */
function loadTestDir(testDir: string, makeId: MakeId, options: LoadOptions): Input {
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
  return normalizeInput(spec, testDir, makeId, options);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to read input JSON ${filePath}: ${(err as Error).message}`);
  }
}

function normalizeInput(raw: unknown, baseDir: string, makeId: MakeId, options: LoadOptions): Input {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Eval input must be a JSON object");
  }
  const spec = raw as Record<string, unknown>;
  if (spec.goal !== undefined && spec.rubric !== undefined) {
    throw new Error("Eval input cannot specify both goal and rubric");
  }
  const requireGoal = options.requireGoal ?? true;
  if (requireGoal && (typeof spec.goal !== "string" || spec.goal.length === 0)) {
    throw new Error("Eval input goal must be a non-empty string");
  }
  if (spec.goal !== undefined && typeof spec.goal !== "string") {
    throw new Error("Eval input goal must be a string when provided");
  }
  if (spec.args !== undefined && !isPlainObject(spec.args)) {
    throw new Error("Eval input args must be an object when provided");
  }
  if (spec.node !== undefined && typeof spec.node !== "string") {
    throw new Error("Eval input node must be a string when provided");
  }
  if (spec.files !== undefined && typeof spec.files !== "string") {
    throw new Error("Eval input files must be a string when provided");
  }
  if (spec.metadata !== undefined && !isPlainObject(spec.metadata)) {
    throw new Error("Eval input metadata must be an object when provided");
  }
  const out: Input = {
    id: typeof spec.id === "string" ? spec.id : makeId(),
    args: (spec.args ?? {}) as Record<string, any>,
    expected: spec.expected,   // any JSON; absent stays undefined
  };
  if (typeof spec.goal === "string") out.goal = spec.goal;
  if (typeof spec.node === "string") out.node = spec.node;
  if (typeof spec.files === "string") out.files = resolveFilesDir(spec.files, baseDir, options, out.id ?? "");
  if (isPlainObject(spec.metadata)) out.metadata = spec.metadata as Record<string, any>;
  return out;
}

/** Resolve a files entry — a local directory or a git source — to an absolute
 *  directory, recording provenance when the caller collects it. */
function resolveFilesDir(raw: string, baseDir: string, options: LoadOptions, inputId: string): string {
  const parsed = parseSource(raw, baseDir);
  if (parsed.kind === "git") {
    if (options.forbidGitFiles) {
      throw new Error(
        `Input ${inputId}: files "${raw}" is a git source, but this suite was itself loaded from git. ` +
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
    throw new Error(`Eval input files must name a directory (got ${raw}, resolved to ${parsed.path})`);
  }
  if (options.filesProvenance) {
    options.filesProvenance[inputId] = { source: raw };
  }
  return fs.realpathSync(parsed.path);
}

/** A non-null, non-array object — the shape `args`/`metadata` must have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInputs(inputs: Input[]): Input[] {
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
