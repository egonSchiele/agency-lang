import fs from "fs";
import path from "path";
import { getModuleDir } from "../runtime/asyncContext.js";

/**
 * Read a skill file colocated with the calling Agency module. The
 * `filepath` is resolved against the module's directory (the directory
 * of the compiled `.js`, which by convention is the directory of the
 * source `.agency` file) via the ALS frame seeded by `runNode` /
 * `runInBootstrapFrame`. Falls back to `process.cwd()` when called
 * outside any Agency execution frame (e.g. from non-Agency host code).
 */
export function _readSkill(filepath: string): string {
  const dirname = getModuleDir();
  const fullPath = path.resolve(dirname, filepath);
  return fs.readFileSync(fullPath, "utf8");
}

export type SkillFile = {
  filename: string;
  content: string;
};

/**
 * List every Markdown file (`*.md` / `*.markdown`) in `dir` (non-recursive)
 * and read it into memory. Used by `skillsDir` to build a tool description
 * out of each file's frontmatter without going through the interrupt-
 * throwing `glob` / `read` wrappers, since `skillsDir` is setup code that
 * runs before any handlers are in scope.
 */
export function _listMarkdownFiles(dir: string): SkillFile[] {
  const root = path.resolve(process.cwd(), dir);
  const entries = fs.readdirSync(root);
  const out: SkillFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md") && !name.endsWith(".markdown")) continue;
    const full = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({ filename: name, content: fs.readFileSync(full, "utf8") });
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}
