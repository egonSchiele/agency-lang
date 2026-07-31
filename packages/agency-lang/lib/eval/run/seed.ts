import * as fs from "fs";
import * as path from "path";

import { agentClosure } from "@/analysis/closure.js";
import type { AgencyConfig } from "@/config.js";
import { compile } from "@/compiler/defaultSession.js";
import { RunStrategy } from "@/importStrategy.js";

/** Which files a run needs: the agent's own (computed from its imports) and
 *  the test's (declared). The description only — copying is `copyFiles`. */
export type AgentSeed = {
  /** Project root the closure paths are relative to. */
  baseDir: string;
  /** Entry .agency file, relative to baseDir. */
  agentRelPath: string;
  /** Absolute paths of the agent's import closure (agency + TS interop). */
  closureFiles: string[];
  /** Resolved test fixture dir; its contents land at the workdir root. */
  filesDir?: string;
};

/** Project files read from cwd at run time; seeded when the project has them. */
const PROJECT_CONFIG_FILES = ["agency.json", ".env"];

/** One planned copy: where the file comes from, and which ingredient provided
 *  it (collision messages name the ingredient). */
export type SeedEntry = { sourceAbs: string; origin: "agent" | "test files" };

/** Walk the agent's imports and build its seed. One closure walk per agent. */
export function seedFromAgentFile(agentPath: string): AgentSeed {
  const absoluteAgent = fs.realpathSync(path.resolve(agentPath));
  const closure = agentClosure(agentPath);
  return {
    baseDir: closure.baseDir,
    agentRelPath: path.relative(closure.baseDir, absoluteAgent),
    closureFiles: closure.files,
  };
}

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

/** Which files to copy, and where: destination (workdir-relative) → source.
 *  Pure — nothing is written. Throws on a test-file/agent collision, naming
 *  the path and both sources. */
export function filesToCopy(seed: AgentSeed): Record<string, SeedEntry> {
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

/** Copy them. The only filesystem writes in seeding. */
export function copyFiles(workdirPath: string, files: Record<string, SeedEntry>): void {
  fs.mkdirSync(workdirPath, { recursive: true });
  for (const [rel, entry] of Object.entries(files)) {
    const dest = resolveWithin(workdirPath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(entry.sourceAbs, dest);
  }
}

/** Write optimizer candidate edits over the seeded copy. Applied last, so a
 *  candidate wins over both ingredients. */
export function applyOverlay(workdirPath: string, overlayFiles: Record<string, string> | undefined): void {
  for (const [rel, source] of Object.entries(overlayFiles ?? {})) {
    const dest = resolveWithin(workdirPath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, source);
  }
}

/** Compile the seeded agent inside its workdir, so module-dir == cwd ==
 *  workdir and all resolution stays inside the sandbox. */
export function compileAgent(workdirPath: string, agentRelPath: string, config: AgencyConfig): string {
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
