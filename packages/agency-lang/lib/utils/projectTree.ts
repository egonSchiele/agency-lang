import * as fs from "fs";
import * as path from "path";

/**
 * Entries never copied into a run/working directory. `package.json` is excluded
 * deliberately so a copied agent's bare `agency-lang` self-import climbs to the
 * real package root instead of binding to an absent local `dist/`.
 *
 * The static `runs` exclude is a convenience for the default config; users can
 * override `--runs-dir` to any name, which is why `copyProjectTree` also skips
 * the top-level entry that contains `destDir` (see `entryContainingDest`).
 */
export const PROJECT_COPY_EXCLUDES = [
  "node_modules", ".git", "dist", "runs", ".worktrees",
  ".agency-tmp", ".js-tmp", ".agency-memory",
  "package.json",
];

/** The top-level entry of `srcDir` whose subtree contains `destDir`, or null
 *  when `destDir` is outside `srcDir`. Skipping it avoids copying a directory
 *  into its own descendant. Handles arbitrary runs-dir names (custom
 *  `--runs-dir`, `optimize-runs`, etc.), not just the literal `runs`. */
function entryContainingDest(srcDir: string, destDir: string): string | null {
  const rel = path.relative(srcDir, destDir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep)[0];
}

/** Copy `srcDir`'s top-level entries into `destDir`, skipping heavy/irrelevant
 *  entries and the one that would copy `destDir` into itself. */
export function copyProjectTree(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const skip = entryContainingDest(srcDir, destDir);
  for (const entry of fs.readdirSync(srcDir)) {
    if (PROJECT_COPY_EXCLUDES.includes(entry)) {
      continue;
    }
    if (entry === skip) {
      continue;
    }
    fs.cpSync(path.join(srcDir, entry), path.join(destDir, entry), { recursive: true });
  }
}
