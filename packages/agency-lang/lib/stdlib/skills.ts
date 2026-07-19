import fs from "fs";
import path from "path";
import { getModuleDir } from "../runtime/asyncContext.js";
import { getStdlibDir } from "../importPaths.js";
import { expandPath } from "./expandPath.js";

/**
 * Read a skill file colocated with the calling Agency module. The
 * `filepath` is resolved against the module's directory (the directory
 * of the compiled `.js`, which by convention is the directory of the
 * source `.agency` file) via the ALS frame seeded by `runNode` /
 * `runInBootstrapFrame`. Falls back to `process.cwd()` when called
 * outside any Agency execution frame (e.g. from non-Agency host code).
 *
 * `filepath` is passed through `expandPath` first so a user-typed
 * `~/.agency/skills/foo.md` resolves to `$HOME/.agency/skills/foo.md`
 * — same shorthand policy every other stdlib path-taking entry point
 * follows (see docs/dev/coding-standards.md). We don't go through
 * `resolvePath`/`resolveDir` because (a) the function is sync by
 * design and `resolveDir` is async, and (b) skills are trusted
 * colocated resources, so the allow-list / symlink-escape checks
 * those helpers run aren't applicable here.
 */
export function _readSkill(filepath: string): string {
  const dirname = getModuleDir();
  const fullPath = path.resolve(dirname, expandPath(filepath));
  return fs.readFileSync(fullPath, "utf8");
}

/**
 * Absolute path to a section of the packaged Agency docs. `make` stages
 * `docs/site/{guide,cli}` into `stdlib/docs/` (see stage-stdlib-docs in
 * the makefile), and stdlib resolves in both dev and npm installs via
 * getStdlibDir, so one copy serves compiled and source runs.
 */
export function _docsDir(section: "guide" | "cli" | "diagnostics" | "stdlib"): string {
  return path.join(getStdlibDir(), "docs", section);
}

/**
 * Absolute path to the skills we ship for one agent, under
 * `stdlib/agents/skills/<agent>`. Resolved through getStdlibDir for the
 * same reason as _docsDir: a path relative to the calling file works in the
 * repo and breaks once the package is installed into node_modules.
 *
 * The name is confined to that directory. `agentSkill` deliberately skips
 * the approval interrupt that `skillsDir` raises, on the grounds that these
 * files ship inside the package, so an `agent` of `"../../.."` would turn a
 * trusted scan into an unprompted scan of somewhere else entirely. Confining
 * here keeps that trust argument true.
 */
export function _agentSkillsDir(agent: string): string {
  const root = path.join(getStdlibDir(), "agents", "skills");
  const resolved = path.resolve(root, agent);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `agentSkill: '${agent}' resolves outside the shipped skills directory. ` +
        `Skill names are relative paths under stdlib/agents/skills.`,
    );
  }
  return resolved;
}
