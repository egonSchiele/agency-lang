import * as fs from "fs";
import * as path from "path";

/**
 * The one rule every command over "several runs" uses to turn paths into run
 * directories: a path that is a run directory (has `statelog.jsonl`) is that
 * run; a directory holding run directories is a group and yields them,
 * sorted, at most TWO levels down: a suite run is `<group>/<testId>/`, and a
 * suite run with repeated trials is `<group>/<testId>/<trial>/`. Nothing
 * deeper is looked at, and `.staging` (a suite still running) is never
 * entered. Anything else is an error. Resolved, absolute paths come back.
 */
export function isRunDirectory(dir: string): boolean {
  // A file, not merely present: a test id may itself be `statelog.jsonl`,
  // making `<group>/statelog.jsonl/` a child run directory, not a statelog.
  try {
    return fs.statSync(path.join(dir, "statelog.jsonl")).isFile();
  } catch {
    return false;
  }
}

export function childRunDirectories(dir: string): string[] {
  const found: string[] = [];
  for (const child of childDirectories(dir)) {
    if (isRunDirectory(child)) {
      found.push(child);
    } else if (path.basename(child) !== STAGING_DIR) {
      found.push(...childDirectories(child).filter(isRunDirectory));
    }
  }
  return found;
}

/** Where `eval run` assembles a test before it is renamed into the group. */
const STAGING_DIR = ".staging";

function childDirectories(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .sort()
    .map((child) => path.join(dir, child))
    .filter((child) => {
      try {
        return fs.statSync(child).isDirectory();
      } catch {
        return false;
      }
    });
}

export function findRunDirectories(paths: string[]): string[] {
  const found: string[] = [];
  for (const given of paths) {
    const resolved = path.resolve(given);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`${given} is not a directory.`);
    }
    if (isRunDirectory(resolved)) {
      found.push(resolved);
      continue;
    }
    const children = childRunDirectories(resolved);
    if (children.length === 0) {
      throw new Error(
        `${given} is not a run directory (no statelog.jsonl) and holds no run directories. ` +
          `Write one with \`agency eval run\`, \`agency run --capture-workdir ${given} <file.agency>\`, ` +
          `or \`agency runs add ${given} --statelog <file>\`.`,
      );
    }
    found.push(...children);
  }
  return found;
}

/** The same run directory once, however many ways the walk reached it.
 *  First appearance wins. Canonical paths (`realpath`), so identity and any
 *  later mutation target come from one source of truth: the walk follows
 *  symlinks while classifying, so two spellings can name one directory. */
export function uniqueRunDirectories(dirs: string[]): string[] {
  const seen: Record<string, true> = Object.create(null);
  const unique: string[] = [];
  for (const dir of dirs) {
    const canonical = fs.realpathSync.native(dir);
    if (seen[canonical] !== true) {
      seen[canonical] = true;
      unique.push(canonical);
    }
  }
  return unique;
}
