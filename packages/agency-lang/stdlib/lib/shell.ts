import { spawn, SpawnOptions } from "child_process";
import process from "process";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
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

function spawnAsync(
  command: string,
  args: string[],
  options: SpawnOptions & { input?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => { stdout += data; });
    child.stderr!.on("data", (data: string) => { stderr += data; });

    if (options.input) {
      child.stdin!.write(options.input);
      child.stdin!.end();
    } else {
      child.stdin!.end();
    }

    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeout);
    }

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ stdout, stderr: stderr + "\nProcess timed out", exitCode: 1 });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

type SpawnAsyncOptions = SpawnOptions & { input?: string; timeout?: number };

function buildSpawnOptions(cwd: string, timeout: number, stdin: string): SpawnAsyncOptions {
  const options: SpawnAsyncOptions = {};
  if (cwd) options.cwd = cwd;
  if (timeout > 0) options.timeout = timeout;
  if (stdin) options.input = stdin;
  return options;
}

export async function _exec(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  stdin: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return spawnAsync(command, args, buildSpawnOptions(cwd, timeout, stdin));
}

export async function _bash(
  command: string,
  cwd: string,
  timeout: number,
  stdin: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return spawnAsync("sh", ["-c", command], buildSpawnOptions(cwd, timeout, stdin));
}

export type LsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
};

export async function _ls(dir: string, recursive: boolean): Promise<LsEntry[]> {
  const root = path.resolve(process.cwd(), dir);
  const out: LsEntry[] = [];

  async function walk(current: string): Promise<void> {
    const names = await fs.readdir(current);
    for (const name of names) {
      const full = path.join(current, name);
      let st: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        st = await fs.lstat(full);
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
        await walk(full);
      }
    }
  }

  await walk(root);
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

type Visitor = (fullPath: string, stat: Awaited<ReturnType<typeof fs.lstat>>) => Promise<boolean>;

async function walkDir(root: string, visit: Visitor): Promise<void> {
  async function walk(current: string): Promise<boolean> {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      return true;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(current, name);
      let st: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        st = await fs.lstat(full);
      } catch {
        continue;
      }
      if (!(await visit(full, st))) return false;
      if (st.isDirectory() && !(await walk(full))) return false;
    }
    return true;
  }
  await walk(root);
}

export async function _grep(
  pattern: string,
  dir: string,
  flags: string,
  maxResults: number,
): Promise<GrepMatch[]> {
  const root = path.resolve(process.cwd(), dir);
  const re = new RegExp(pattern, flags || undefined);
  const results: GrepMatch[] = [];

  await walkDir(root, async (full, st) => {
    if (!st.isFile()) return true;
    if (st.size > 5_000_000) return true;
    let text: string;
    try {
      text = await fs.readFile(full, "utf8");
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

export async function _glob(
  pattern: string,
  dir: string,
  maxResults: number,
): Promise<string[]> {
  const root = path.resolve(process.cwd(), dir);
  const re = globToRegExp(pattern);
  const results: string[] = [];

  await walkDir(root, async (full) => {
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
    if (c === "{") {
      depth++;
      if (depth > 1) {
        throw new Error(
          `invalid glob pattern: nested braces are not supported in ${glob}`,
        );
      }
    } else if (c === "}") {
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

export async function _stat(filename: string): Promise<StatInfo> {
  const full = path.resolve(process.cwd(), filename);
  try {
    const st = await fs.lstat(full);
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

export async function _exists(filename: string): Promise<boolean> {
  const full = path.resolve(process.cwd(), filename);
  try {
    await fs.access(full);
    return true;
  } catch {
    return false;
  }
}

export async function _which(command: string): Promise<string> {
  if (command.length === 0) return "";
  if (command.includes("/") || command.includes("\\") || command.includes("\0")) {
    throw new Error(
      `which: command name must not contain path separators or NUL bytes (got '${command}')`,
    );
  }
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter((d) => d.length > 0);
  const isWindows = process.platform === "win32";
  const extensions = isWindows
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.resolve(dir, command + ext);
      try {
        const st = await fs.stat(candidate);
        if (!st.isFile()) continue;
        if (!isWindows) {
          await fs.access(candidate, fsConstants.X_OK);
        }
        return candidate;
      } catch {}
    }
  }
  return "";
}
