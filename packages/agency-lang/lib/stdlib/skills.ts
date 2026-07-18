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
