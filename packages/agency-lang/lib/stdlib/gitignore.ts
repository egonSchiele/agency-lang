// Enough of .gitignore for a file walk to skip what git would: comments,
// negation, directory-only rules, anchored and unanchored patterns, and
// nested .gitignore files that refine their parents. Not covered:
// .git/info/exclude and the global excludes file, which live outside the
// tree being walked.
import fs from "fs/promises";
import path from "path";
import picomatch from "picomatch";

type Rule = {
  /** Matches the path itself, relative to the directory the .gitignore lives in. */
  matchesSelf: (relativePath: string) => boolean;
  /** Matches a path somewhere under a directory the pattern names. */
  matchesUnder: (relativePath: string) => boolean;
  /** A `!pattern` rule: a match un-ignores instead of ignoring. */
  negated: boolean;
  /** A trailing `/`: the rule names directories only. */
  directoriesOnly: boolean;
};

/** Whether one rule speaks to this path at all. A directories-only rule
 * still covers the files under a directory it names. */
function ruleApplies(rule: Rule, relativePath: string, isDirectory: boolean): boolean {
  // Self first: `**` matches zero segments, so the under-pattern also
  // matches the named path itself and would skip the directories-only check.
  if (rule.matchesSelf(relativePath)) return isDirectory || !rule.directoriesOnly;
  return rule.matchesUnder(relativePath);
}

/** The rules of one .gitignore file, scoped to the directory holding it. */
export type GitignoreFile = {
  dir: string;
  rules: Rule[];
};

const MATCH_OPTIONS = { dot: true, nobrace: false, nonegate: true };

export function parseGitignore(dir: string, text: string): GitignoreFile {
  const rules: Rule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // A trailing space is ignored unless escaped; we do not model the
    // escape, so trim.
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    let pattern = line;
    const negated = pattern.startsWith("!");
    if (negated) pattern = pattern.slice(1);
    const directoriesOnly = pattern.endsWith("/");
    if (directoriesOnly) pattern = pattern.slice(0, -1);
    if (pattern === "") continue;
    // A slash anywhere but the end anchors the pattern to this directory.
    // Without one, the pattern matches at any depth.
    const anchored = pattern.startsWith("/") || pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    const glob = anchored ? pattern : `**/${pattern}`;
    rules.push({
      matchesSelf: picomatch(glob, MATCH_OPTIONS),
      matchesUnder: picomatch(`${glob}/**`, MATCH_OPTIONS),
      negated,
      directoriesOnly,
    });
  }
  return { dir, rules };
}

/** The .gitignore in `dir`, or null when there is none. */
export async function readGitignore(dir: string): Promise<GitignoreFile | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  return parseGitignore(dir, text);
}

/**
 * Whether git would ignore `fullPath`, given the .gitignore files on the
 * path from the walk root down to its parent (outermost first). The last
 * matching rule wins, and a deeper file's rules come after a shallower
 * file's, which is how git resolves the same question.
 */
export function isIgnored(fullPath: string, isDirectory: boolean, files: GitignoreFile[]): boolean {
  let ignored = false;
  for (const file of files) {
    const relative = path.relative(file.dir, fullPath).split(path.sep).join("/");
    if (relative.startsWith("..")) continue;
    for (const rule of file.rules) {
      if (ruleApplies(rule, relative, isDirectory)) ignored = !rule.negated;
    }
  }
  return ignored;
}
