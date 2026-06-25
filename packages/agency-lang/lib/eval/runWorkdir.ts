import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { compile } from "@/cli/commands.js";
import { RunStrategy } from "@/importStrategy.js";

import { copyProjectTree } from "@/utils/projectTree.js";

/** Declarative description of a per-input run directory: where the project
 *  tree is seeded from, where the entry agent lives within it, and any
 *  candidate-file overlay applied before compile. */
export type RunWorkdirSpec = {
  /** Absolute dir whose contents seed the workdir (the agent's project tree). */
  seedDir: string;
  /** Entry agent path relative to seedDir, e.g. "examples/08-optimize.agency". */
  agentRelPath: string;
  /** Optional overlay applied after seeding — the optimizer's mutated candidate
   *  files, keyed by path relative to seedDir. Absent for plain eval. */
  overlayFiles?: Record<string, string>;
};

export type PreparedRunDir = {
  workdirPath: string;
  /** Absolute path of the compiled entry JS inside the workdir. */
  compiledEntryPath: string;
};

/** Resolve `rel` against `workdirPath` and refuse paths that escape it (`..`,
 *  absolute). Overlay keys come from optimizer candidates today but may flow in
 *  from less-trusted callers later; this is the same guard the prior
 *  `WorkspaceManager.resolveWithin` provided. */
function resolveWithin(workdirPath: string, rel: string): string {
  const root = path.resolve(workdirPath);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path ${JSON.stringify(rel)} escapes the workdir ${root}`);
  }
  return abs;
}

/** Write each overlay file (path relative to the workdir root) over the seeded copy. */
function applyOverlay(workdirPath: string, overlayFiles: Record<string, string>): void {
  for (const [rel, source] of Object.entries(overlayFiles)) {
    const abs = resolveWithin(workdirPath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
  }
}

/**
 * Materialize an isolated run directory: copy the seed project tree into
 * `workdirPath`, overlay the candidate's mutated files (if any), then compile
 * the entry agent in place. The result has module-dir == cwd == workdir, so the
 * agent's reads, writes, and execs all resolve to this one isolated copy.
 */
export function prepareRunDir(
  spec: RunWorkdirSpec,
  workdirPath: string,
  config: AgencyConfig,
): PreparedRunDir {
  copyProjectTree(spec.seedDir, workdirPath);
  if (spec.overlayFiles) {
    applyOverlay(workdirPath, spec.overlayFiles);
  }

  const entryAgency = resolveWithin(workdirPath, spec.agentRelPath);
  const compiledEntryPath = compile(config, entryAgency, undefined, {
    importStrategy: new RunStrategy(),
    quiet: true,
  });
  if (compiledEntryPath === null) {
    throw new Error(`Failed to compile ${entryAgency}`);
  }
  return { workdirPath, compiledEntryPath };
}
