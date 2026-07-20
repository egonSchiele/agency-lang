import fs from "fs";
import path from "path";
import { getStdlibDir } from "../importPaths.js";
import { resolveCwdPath } from "./resolveDir.js";

/**
 * Read a skill file. `filepath` resolves against `process.cwd()` like
 * every other path-taking stdlib entry point; a skill colocated with
 * the calling Agency file is read with
 * `readSkill(__dirname + "/skills/x.md")`. `~` expands
 * (`resolveCwdPath` runs `expandPath`) so `~/.agency/skills/foo.md`
 * works. No allow-list / symlink checks: skills are trusted resources
 * and the function is sync by design (`resolveDir` is async;
 * `resolveCwdPath` is its sync core).
 */
export function _readSkill(filepath: string): string {
  return fs.readFileSync(resolveCwdPath(filepath), "utf8");
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
