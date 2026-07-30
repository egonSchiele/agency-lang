import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { compile } from "@/cli/commands.js";
import { RunStrategy } from "@/importStrategy.js";
import { copyProjectTree } from "@/utils/projectTree.js";

import type { EvalInputRunner } from "./runEvalInput.js";

export type SeededSeed = {
  kind: "seeded";
  /** Project root the closure paths are relative to. */
  baseDir: string;
  /** Entry .agency file, relative to baseDir. */
  agentRelPath: string;
  /** Absolute paths of the agent's import closure (agency + TS interop). */
  closureFiles: string[];
  /** Resolved test fixture dir; its contents land at the workdir root. */
  filesDir?: string;
};
export type LegacyCloneSeed = {
  kind: "legacyClone";
  baseDir: string;
  agentRelPath: string;
  /** Deprecated working_dir: full clone, old behavior. */
  cloneDir: string;
};
export type RunSeed = SeededSeed | LegacyCloneSeed;

/** Project files read from cwd at run time; seeded when the project has them. */
const PROJECT_CONFIG_FILES = ["agency.json", ".env"];

/** One planned seed entry: where the file comes from, and which ingredient
 *  provided it (collision messages name the ingredient). */
type SeedEntry = { sourceAbs: string; origin: "agent" | "test files" };

/** Resolve `rel` against `root`, refusing escapes. Overlay keys come from
 *  optimizer candidates today but may flow in from less-trusted callers
 *  later. */
function resolveWithin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, rel);
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path ${JSON.stringify(rel)} escapes the workdir ${resolvedRoot}`);
  }
  return abs;
}

/** Every file under `dir`, as dir-relative paths, sorted. */
function listFilesRecursive(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** The seed as a pure map of workdir-relative path → entry. Throws on a
 *  test-file/agent collision, naming the path and both sources. */
function planSeed(seed: SeededSeed): Record<string, SeedEntry> {
  const agentEntries: Record<string, SeedEntry> = Object.fromEntries([
    ...seed.closureFiles.map((abs): [string, SeedEntry] =>
      [path.relative(seed.baseDir, abs), { sourceAbs: abs, origin: "agent" }]),
    ...PROJECT_CONFIG_FILES
      .filter((name) => fs.existsSync(path.join(seed.baseDir, name)))
      .map((name): [string, SeedEntry] =>
        [name, { sourceAbs: path.join(seed.baseDir, name), origin: "agent" }]),
  ]);
  const testEntries: Record<string, SeedEntry> = Object.fromEntries(
    (seed.filesDir ? listFilesRecursive(seed.filesDir) : []).map((rel): [string, SeedEntry] =>
      [rel, { sourceAbs: path.join(seed.filesDir as string, rel), origin: "test files" }]),
  );

  // Object.hasOwn, not a truthiness lookup: a fixture file named "toString"
  // must not collide with Object.prototype's inherited members.
  const collisions = Object.keys(testEntries).filter((rel) => Object.hasOwn(agentEntries, rel));
  if (collisions.length > 0) {
    const rel = collisions[0];
    throw new Error(
      `Seed collision at "${rel}": provided by both the test files (${testEntries[rel].sourceAbs}) ` +
      `and the agent (${agentEntries[rel].sourceAbs}). Tests must not ship agent files — ` +
      `the agent is seeded separately so one suite can grade any agent.`,
    );
  }
  return { ...agentEntries, ...testEntries };
}

/** The only filesystem writes in seeding. */
function materialize(workdirPath: string, entries: Record<string, SeedEntry>): void {
  fs.mkdirSync(workdirPath, { recursive: true });
  for (const [rel, entry] of Object.entries(entries)) {
    const dest = resolveWithin(workdirPath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(entry.sourceAbs, dest);
  }
}

function applyOverlay(workdirPath: string, overlayFiles: Record<string, string> | undefined): void {
  for (const [rel, source] of Object.entries(overlayFiles ?? {})) {
    const dest = resolveWithin(workdirPath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, source);
  }
}

/** Deprecated working_dir path: the old full clone, verbatim — including
 *  copyProjectTree's known self-copy-guard quirk under symlinked temp dirs.
 *  Do not "fix" that here; this whole branch dies with working_dir. */
function cloneLegacy(workdirPath: string, seed: LegacyCloneSeed): string[] {
  copyProjectTree(seed.cloneDir, workdirPath);
  return listFilesRecursive(workdirPath);
}

/** The two-ingredient seed: plan (pure, collision-checked), then write. */
function seedFromPlan(workdirPath: string, seed: SeededSeed): string[] {
  const entries = planSeed(seed);
  materialize(workdirPath, entries);
  return Object.keys(entries).sort();
}

function compileEntry(workdirPath: string, agentRelPath: string, config: AgencyConfig): string {
  const entryAgency = resolveWithin(workdirPath, agentRelPath);
  const compiledEntryPath = compile(config, entryAgency, undefined, {
    importStrategy: new RunStrategy(),
    quiet: true,
  });
  if (compiledEntryPath === null) {
    throw new Error(`Failed to compile ${entryAgency}`);
  }
  return compiledEntryPath;
}

/**
 * One isolated run directory: seeded from the test's files plus the agent's
 * closure, compiled in place, executed with cwd = workdir. Replaces the old
 * clone-the-whole-project prepareRunDir.
 */
export class Workspace {
  private constructor(
    readonly workdirPath: string,
    readonly compiledEntryPath: string,
    /** Workdir-relative paths that were seeded (sorted). For diagnostics. */
    readonly seededFiles: string[],
  ) {}

  static create(args: {
    workdirPath: string;
    seed: RunSeed;
    overlayFiles?: Record<string, string>;
    config: AgencyConfig;
  }): Workspace {
    const seededFiles = args.seed.kind === "legacyClone"
      ? cloneLegacy(args.workdirPath, args.seed)
      : seedFromPlan(args.workdirPath, args.seed);
    applyOverlay(args.workdirPath, args.overlayFiles);
    return new Workspace(
      args.workdirPath,
      compileEntry(args.workdirPath, args.seed.agentRelPath, args.config),
      seededFiles,
    );
  }

  run(
    runner: EvalInputRunner,
    args: { node: string; args: Record<string, any>; statelogPath: string },
  ): ReturnType<EvalInputRunner> {
    return runner({
      compiledEntryPath: this.compiledEntryPath,
      node: args.node,
      args: args.args,
      cwd: this.workdirPath,
      statelogPath: args.statelogPath,
    });
  }
}
