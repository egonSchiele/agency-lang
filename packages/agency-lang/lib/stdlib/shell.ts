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
import { getModuleDir, getRuntimeContext } from "../runtime/asyncContext.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";
import {
  abortableSpawn,
  AbortableSpawnOptions,
  SpawnResult,
} from "./abortable.js";
import { checkAllowBlockList } from "./allowBlockList.js";
import { assertContained } from "./assertContained.js";
import { resolveDir } from "./resolveDir.js";
import { resolvePath } from "./resolvePath.js";

function buildSpawnOptions(
  cwd: string,
  timeout: number,
  stdin: string,
  signal: AbortSignal,
): AbortableSpawnOptions {
  const options: AbortableSpawnOptions = { signal };
  if (cwd) options.cwd = cwd;
  if (timeout > 0) options.timeout = timeout;
  if (stdin) options.input = stdin;
  return options;
}

export type ExecOptions = {
  /**
   * Allow-list of executable names. When set, only commands whose
   * `command` matches one of these strings (case-insensitive,
   * whitespace-trimmed) will run. Empty / unset = no restriction.
   * Pair with `allowedPaths` to also pin the working directory.
   */
  allowedExecutables?: string[];
  /**
   * Block-list of executable names. When set, any command whose
   * `command` matches one of these strings is rejected.
   */
  blockedCommands?: string[];
  /**
   * Directory-allow-list for `cwd`. When set, `cwd` must resolve
   * inside one of these roots (symlink-aware). Empty / unset = no
   * restriction.
   */
  allowedPaths?: string[];
};

/**
 * Run a subprocess with abort propagation. `abortableSpawn` sends
 * SIGTERM to the child when the signal fires and rejects with
 * `AgencyCancelledError`. Previously a slow subprocess kept running
 * and held its stdout/stderr pipes open even after the user cancelled.
 */
async function execImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  stdin: string,
  options?: ExecOptions,
): Promise<SpawnResult> {
  const cmdError = checkAllowBlockList(
    [command],
    options?.allowedExecutables ?? [],
    options?.blockedCommands ?? [],
  );
  if (cmdError) throw new Error(cmdError);
  // Route through `resolveDir` (cwd-anchored) so `~` expansion +
  // allow-list enforcement land in one place. Relative `cwd: "./sub"`
  // stays anchored to `process.cwd()` (the existing semantics) because
  // we pass `base: "cwd"`. Empty `cwd` is the "no override" sentinel —
  // pass undefined to the spawn options so the child inherits the
  // parent's cwd, matching the pre-migration behavior.
  const cwdResolved = cwd
    ? await resolveDir(cwd, options?.allowedPaths ?? [], "cwd")
    : "";
  const signal = ctx.getAbortSignal(stack);
  return abortableSpawn(command, args, buildSpawnOptions(cwdResolved, timeout, stdin, signal));
}

/** Deprecated context-injected wrapper kept during the ALS migration;
 *  see `_exec`. */
export async function __internal_exec(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  stdin: string,
  options?: ExecOptions,
): Promise<SpawnResult> {
  return execImpl(ctx, stack, command, args, cwd, timeout, stdin, options);
}

/** ALS-reading replacement for `__internal_exec`. */
export async function _exec(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  stdin: string,
  options?: ExecOptions,
): Promise<SpawnResult> {
  const { ctx, stack } = getRuntimeContext();
  return execImpl(ctx, stack, command, args, cwd, timeout, stdin, options);
}

export type BashOptions = {
  /**
   * Reject any bash string whose first non-whitespace token matches
   * one of these entries (prefix match). Useful to block `rm`,
   * `sudo`, etc.
   */
  blockedCommands?: string[];
  /**
   * Directory-allow-list for `cwd`. When set, `cwd` must resolve
   * inside one of these roots (symlink-aware). Empty / unset = no
   * restriction.
   */
  allowedPaths?: string[];
};

/**
 * Like {@link execImpl} but routes the command through `sh -c`. Pipes
 * and subshells get torn down when SIGTERM hits the parent shell,
 * which then propagates to its children.
 */
async function bashImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  command: string,
  cwd: string,
  timeout: number,
  stdin: string,
  options?: BashOptions,
): Promise<SpawnResult> {
  if (options?.blockedCommands && options.blockedCommands.length > 0) {
    const trimmed = command.trimStart();
    for (const blocked of options.blockedCommands) {
      if (trimmed.startsWith(blocked)) {
        throw new Error(`Command "${blocked}" is in the blockedCommands list.`);
      }
    }
  }
  // See `execImpl` for the cwd-resolution rationale.
  const cwdResolved = cwd
    ? await resolveDir(cwd, options?.allowedPaths ?? [], "cwd")
    : "";
  const signal = ctx.getAbortSignal(stack);
  return abortableSpawn("sh", ["-c", command], buildSpawnOptions(cwdResolved, timeout, stdin, signal));
}

/** Deprecated context-injected wrapper kept during the ALS migration;
 *  see `_bash`. */
export async function __internal_bash(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  command: string,
  cwd: string,
  timeout: number,
  stdin: string,
  options?: BashOptions,
): Promise<SpawnResult> {
  return bashImpl(ctx, stack, command, cwd, timeout, stdin, options);
}

/** ALS-reading replacement for `__internal_bash`. */
export async function _bash(
  command: string,
  cwd: string,
  timeout: number,
  stdin: string,
  options?: BashOptions,
): Promise<SpawnResult> {
  const { ctx, stack } = getRuntimeContext();
  return bashImpl(ctx, stack, command, cwd, timeout, stdin, options);
}

export type LsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
};

// Cap on how many entries a single `ls` returns. Without this, a
// recursive listing of a project root could return a multi-million
// entry tree (which once produced a ~48MB / ~12M-token blob fed back to
// an LLM). The Agency `ls` wrapper passes an explicit value; this is a
// safety default for direct callers.
const DEFAULT_LS_MAX_RESULTS = 1000;

export async function _ls(
  dir: string,
  recursive: boolean,
  allowedPaths?: string[],
  maxResults: number = DEFAULT_LS_MAX_RESULTS,
): Promise<LsEntry[]> {
  // Resolve relative `dir` against the calling module's directory (same
  // policy as `read`/`write`), so co-located resource folders work no
  // matter where the process was launched from. Absolute paths pass
  // through unchanged. `~` is expanded; `allowedPaths` is resolved
  // against the same base — relative roots like `"."` mean "the same
  // dir as `dir`". All policy lives in `resolveDir` so future rules
  // (env vars, normalization, etc.) propagate automatically.
  const root = await resolveDir(dir, allowedPaths ?? []);
  const out: LsEntry[] = [];

  // Returns false to signal "stop walking" (cap reached).
  async function walk(current: string): Promise<boolean> {
    let names: string[];
    try {
      names = await fs.readdir(current);
    } catch {
      return true;
    }
    for (const name of names) {
      // On a recursive walk, skip the heavyweight dirs entirely — don't
      // list them and don't descend. A non-recursive `ls` still shows
      // them (the user asked for exactly this directory's contents).
      if (recursive && SKIP_DIRS.has(name)) continue;
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
        // Return paths relative to the scanned `dir` so the result
        // composes naturally with `read(path, dir)` / `glob`.
        path: toPosix(path.relative(root, full)),
        type,
        size: st.size,
      });
      if (out.length >= maxResults) return false;
      if (recursive && type === "dir") {
        if (!(await walk(full))) return false;
      }
    }
    return true;
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
  allowedPaths?: string[],
): Promise<GrepMatch[]> {
  // See `_ls` for the resolution policy. `dir` is module-relative;
  // returned `file` paths are relative to `dir` so callers can hand
  // them to `read(file, dir)` directly.
  const root = await resolveDir(dir, allowedPaths ?? []);
  const re = new RegExp(pattern, flags || undefined);
  const results: GrepMatch[] = [];

  await walkDir(root, async (full, st) => {
    if (!st.isFile()) return true;
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
          file: toPosix(path.relative(root, full)),
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
  allowedPaths?: string[],
): Promise<string[]> {
  // See `_ls` for the resolution policy. `dir` is module-relative;
  // returned paths are relative to `dir` so callers can hand them to
  // `read(path, dir)` directly without `basename(...)` gymnastics.
  const root = await resolveDir(dir, allowedPaths ?? []);
  const re = globToRegExp(pattern);
  const results: string[] = [];

  await walkDir(root, async (full) => {
    const rel = toPosix(path.relative(root, full));
    if (re.test(rel)) {
      results.push(rel);
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

/**
 * Resolve a probe path for `stat`/`exists`, applying the same path
 * policy (shorthand expansion + allow-list containment) every other
 * stdlib path-taking entry point uses.
 *
 * - If `dir` is the empty string (the legacy / unset sentinel),
 *   `filename` is treated as a stand-alone probe path anchored to
 *   `process.cwd()`. Routed through `resolveDir` so `_stat("~", "")`
 *   and `_exists("~/foo", "")` expand the shorthand.
 * - Otherwise resolve via `resolvePath(dir, filename)` (which delegates
 *   dir-expansion + module-dir anchoring to `resolveDir` and runs the
 *   traversal / symlink-escape checks), then layer the allow-list
 *   check on top — `resolvePath` doesn't take `allowedPaths` because
 *   it's the lower-level helper.
 *
 * Probing for a path outside the allow-list is itself a containment
 * violation — both `_stat` and `_exists` throw rather than silently
 * report missing.
 */
async function resolveProbePath(
  dir: string,
  filename: string,
  allowedPaths: string[],
): Promise<string> {
  if (dir === "") {
    return resolveDir(filename, allowedPaths, "cwd");
  }
  const full = await resolvePath(dir, filename);
  await assertContained(full, allowedPaths, getModuleDir());
  return full;
}

export async function _stat(
  filename: string,
  dir: string = "",
  allowedPaths?: string[],
): Promise<StatInfo> {
  const full = await resolveProbePath(dir, filename, allowedPaths ?? []);
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

export async function _exists(
  filename: string,
  dir: string = "",
  allowedPaths?: string[],
): Promise<boolean> {
  const full = await resolveProbePath(dir, filename, allowedPaths ?? []);
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
