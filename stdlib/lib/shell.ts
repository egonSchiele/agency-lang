import { spawnSync, SpawnSyncOptions } from "child_process";
import process from "process";
import fs from "fs";
import path from "path";
import {
  anyChar,
  capture,
  char,
  many,
  map,
  noneOf,
  or,
  Parser,
  sepBy,
  seqC,
  str,
} from "tarsec";

export function _bash(
  command: string,
  cwd: string,
  timeout: number,
  stdin: string,
): { stdout: string; stderr: string; exitCode: number } {
  const options: SpawnSyncOptions = {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  };

  if (cwd) {
    options.cwd = cwd;
  }
  if (timeout > 0) {
    options.timeout = timeout * 1000;
  }
  if (stdin) {
    options.input = stdin;
  }

  const result = spawnSync("sh", ["-c", command], options);
  return {
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
    exitCode: result.status ?? 1,
  };
}

export type LsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
};

export function _ls(dir: string, recursive: boolean): LsEntry[] {
  const root = path.resolve(process.cwd(), dir);
  const out: LsEntry[] = [];

  function walk(current: string): void {
    const names = fs.readdirSync(current);
    for (const name of names) {
      const full = path.join(current, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      let type: LsEntry["type"] = "other";
      if (st.isSymbolicLink()) type = "symlink";
      else if (st.isDirectory()) type = "dir";
      else if (st.isFile()) type = "file";
      out.push({
        name,
        path: toPosix(path.relative(process.cwd(), full)),
        type,
        size: st.size,
      });
      if (recursive && type === "dir") {
        walk(full);
      }
    }
  }

  walk(root);
  return out;
}

function toPosix(p: string): string {
  return path.sep === "\\" ? p.replace(/\\/g, "/") : p;
}

export type GrepMatch = {
  file: string;
  line: number;
  text: string;
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
]);

type Visitor = (fullPath: string, stat: fs.Stats) => boolean;

function walkDir(root: string, visit: Visitor): void {
  function walk(current: string): boolean {
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return true;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(current, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!visit(full, st)) return false;
      if (st.isDirectory() && !walk(full)) return false;
    }
    return true;
  }
  walk(root);
}

export function _grep(
  pattern: string,
  dir: string,
  flags: string,
  maxResults: number,
): GrepMatch[] {
  const root = path.resolve(process.cwd(), dir);
  const re = new RegExp(pattern, flags || undefined);
  const results: GrepMatch[] = [];

  walkDir(root, (full, st) => {
    if (!st.isFile()) return true;
    if (st.size > 5_000_000) return true;
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      return true;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        results.push({
          file: toPosix(path.relative(process.cwd(), full)),
          line: i + 1,
          text: lines[i],
        });
        if (results.length >= maxResults) return false;
      }
      re.lastIndex = 0;
    }
    return true;
  });

  return results;
}

export function _glob(
  pattern: string,
  dir: string,
  maxResults: number,
): string[] {
  const root = path.resolve(process.cwd(), dir);
  const re = globToRegExp(pattern);
  const results: string[] = [];

  walkDir(root, (full) => {
    const rel = toPosix(path.relative(root, full));
    if (re.test(rel)) {
      results.push(toPosix(path.relative(process.cwd(), full)));
      if (results.length >= maxResults) return false;
    }
    return true;
  });

  return results;
}

function globToRegExp(glob: string): RegExp {
  let depth = 0;
  for (const c of glob) {
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) {
        throw new Error(`invalid glob pattern: unmatched '}' in ${glob}`);
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`invalid glob pattern: unmatched '{' in ${glob}`);
  }

  const result = globParser(glob);
  if (!result.success || (result.rest ?? "") !== "") {
    throw new Error(`invalid glob pattern: ${glob}`);
  }
  return new RegExp("^" + result.result + "$");
}

function escapeRegex(s: string): string {
  return s.replace(/[.+()|^$\[\]{}\\*?]/g, "\\$&");
}

const doubleStar: Parser<string> = map(or(str("**/"), str("**")), () => ".*");
const singleStar: Parser<string> = map(char("*"), () => "[^/]*");
const questionMark: Parser<string> = map(char("?"), () => "[^/]");

const braceAlt: Parser<string> = map(many(noneOf(",}")), (chars: string[]) =>
  chars.join(""),
);

const braceGroup: Parser<string> = map(
  seqC(
    char("{"),
    capture(sepBy(char(","), braceAlt), "alts"),
    char("}"),
  ),
  ({ alts }) => "(?:" + alts.map(escapeRegex).join("|") + ")",
);

const literalChar: Parser<string> = map(anyChar, escapeRegex);

const globElement: Parser<string> = or(
  doubleStar,
  singleStar,
  questionMark,
  braceGroup,
  literalChar,
);

const globParser: Parser<string> = map(many(globElement), (parts: string[]) =>
  parts.join(""),
);

export type StatInfo = {
  exists: boolean;
  type: "file" | "dir" | "symlink" | "other" | "missing";
  size: number;
  modifiedMs: number;
};

export function _stat(filename: string): StatInfo {
  const full = path.resolve(process.cwd(), filename);
  try {
    const st = fs.lstatSync(full);
    let type: StatInfo["type"] = "other";
    if (st.isSymbolicLink()) type = "symlink";
    else if (st.isDirectory()) type = "dir";
    else if (st.isFile()) type = "file";
    return {
      exists: true,
      type,
      size: st.size,
      modifiedMs: st.mtimeMs,
    };
  } catch {
    return { exists: false, type: "missing", size: 0, modifiedMs: 0 };
  }
}

export function _exists(filename: string): boolean {
  const full = path.resolve(process.cwd(), filename);
  return fs.existsSync(full);
}
