import process from "process";
import { compileGrepQuery, type GrepPlan, type GrepQuery } from "./grepQuery.js";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { anyChar, capture, char, many, map, noneOf, or, Parser, sepBy, seqC, str } from "tarsec";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";
import { abortableSpawn, AbortableSpawnOptions, SpawnResult } from "./abortable.js";
import { checkAllowBlockList } from "./allowBlockList.js";
import { assertContained } from "./assertContained.js";
import { resolveDir } from "./resolveDir.js";
import { root, resolveUnder, list, stat, readText, type Root, type Entry } from "./contained.js";
import {
  type GitignoreFile,
  isIgnored,
  readAncestorGitignores,
  readGitignore,
} from "./gitignore.js";

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

/**
 * Resolve a spawn `cwd` (empty string = inherit the parent's cwd) and verify
 * the directory EXISTS before handing it to `child_process.spawn`.
 *
 * Node reports a missing spawn cwd as `spawn <command> ENOENT` — which reads
 * as "the executable wasn't found" and gives an LLM agent nothing to act on.
 * It fires whenever the agent points `cwd` at a directory it hasn't created
 * yet — e.g. `setAgentCwd("/tmp/build")` (or `bash(cwd: "/tmp/build")`) before
 * the `mkdir`, a chicken-and-egg the shell can't resolve because it can't even
 * start in a directory that doesn't exist. Fail early with a clear, actionable
 * message instead so the model creates the directory first.
 */
/**
 * A cwd containing newlines, angle brackets, or null bytes is never a real
 * path — it is a corrupted tool-call argument (models occasionally leak
 * fragments of their own function-calling markup, e.g. "</parameter>", into
 * argument values). Without this check the garbage gets appended to a real
 * path in a "directory does not exist" error, which reads as "my workspace
 * is gone" — and agents have abandoned a correct working directory over it.
 * The message must say the opposite: the filesystem is fine, fix the call.
 */
function rejectCorruptedCwd(cwd: string): void {
  const found = ["\n", "\r", "<", ">", "\0"].filter((ch) => cwd.includes(ch));
  if (found.length === 0) return;
  const shown = found.map((ch) => JSON.stringify(ch)).join(", ");
  throw new Error(
    `The cwd argument is not a valid path: it contains ${shown}. ` +
      `This is a corrupted tool-call argument, not a filesystem problem — ` +
      `your working directory is unchanged and any files you created are ` +
      `still there. Retry the call with a plain path, or omit cwd to use ` +
      `the current directory.`,
  );
}

async function resolveSpawnCwd(cwd: string, allowedPaths: string[]): Promise<string> {
  if (!cwd) return "";
  rejectCorruptedCwd(cwd);
  const resolved = await resolveDir(cwd, allowedPaths);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(
        `Working directory does not exist: ${resolved}. ` +
          "Create it first (e.g. `mkdir -p` from an existing directory, or " +
          "another tool to create directories that you have access to) " +
          "before running a command there.",
      );
    }
    throw e;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${resolved}.`);
  }
  return resolved;
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
  // Route through `resolveSpawnCwd` (cwd-anchored) so `~` expansion,
  // allow-list enforcement, and the exists-before-spawn check land in one
  // place. Relative `cwd: "./sub"` stays anchored to `process.cwd()` (the
  // existing semantics) because we pass `base: "cwd"`. Empty `cwd` is the
  // "no override" sentinel — the child inherits the parent's cwd.
  const cwdResolved = await resolveSpawnCwd(cwd, options?.allowedPaths ?? []);
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
  const cwdResolved = await resolveSpawnCwd(cwd, options?.allowedPaths ?? []);
  const signal = ctx.getAbortSignal(stack);
  return abortableSpawn(
    "sh",
    ["-c", command],
    buildSpawnOptions(cwdResolved, timeout, stdin, signal),
  );
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

/** The approved directory as a Root, with the program's own allow-list
 *  applied to it. Every directory-walking primitive starts here. */
async function approvedRoot(rootDir: string, allowedPaths: string[] | undefined): Promise<Root> {
  await assertContained(rootDir, allowedPaths ?? [], process.cwd());
  return root(rootDir);
}

function joinRel(rel: string, name: string): string {
  return rel === "." || rel === "" ? name : path.join(rel, name);
}

/** A walk result relative to the directory the caller asked about, so it
 *  composes with `read(path, dir)`. */
function relativeTo(dir: string, rel: string): string {
  return toPosix(path.relative(dir === "." ? "" : dir, rel));
}

/**
 * List `dir`, a directory under `rootDir` ("." for the root itself).
 * Entries come back relative to `dir`. Symlinked entries are left out:
 * a link below the root is never followed, so there is nothing to say
 * about it. `isRoot` surfaces a readdir failure on the scanned dir
 * itself, while an unreadable subdirectory during a recursive walk is
 * skipped rather than failing the whole listing.
 */
export async function _ls(
  rootDir: string,
  dir: string,
  recursive: boolean,
  maxResults: number = DEFAULT_LS_MAX_RESULTS,
  allowedPaths?: string[],
): Promise<LsEntry[]> {
  const approved = await approvedRoot(rootDir, allowedPaths);
  // Coerce the cap so a non-finite value (e.g. NaN) can't silently
  // disable the bound and reintroduce unbounded recursion. `0` (and any
  // value <= 0) is a valid request that yields an empty result.
  const cap = Number.isFinite(maxResults) ? maxResults : DEFAULT_LS_MAX_RESULTS;
  const out: LsEntry[] = [];

  function walk(rel: string, isRoot: boolean): boolean {
    let entries: Entry[];
    try {
      entries = list(approved, rel);
    } catch (err) {
      if (isRoot) throw err;
      return true;
    }
    for (const entry of entries) {
      if (out.length >= cap) return false;
      // On a recursive walk, skip the heavyweight dirs entirely. A
      // non-recursive `ls` still shows them.
      if (recursive && SKIP_DIRS.has(entry.name)) continue;
      const entryRel = joinRel(rel, entry.name);
      out.push({
        name: entry.name,
        path: relativeTo(dir, entryRel),
        type: entry.type,
        size: entry.size,
      });
      if (recursive && entry.type === "dir" && !walk(entryRel, false)) return false;
    }
    return true;
  }

  walk(dir, true);
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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);

type Visitor = (rel: string, entry: Entry) => Promise<boolean>;

type WalkOptions = {
  /** Skip whatever the .gitignore files between the root and an entry
   * would ignore. Off, the walk skips only SKIP_DIRS. */
  respectGitignore?: boolean;
};

/** Walk `dir` under the approved root. A `dir` that is itself a symlink
 *  below the root is refused before the walk starts; a missing `dir`
 *  yields nothing. */
async function walkDir(
  approved: Root,
  dir: string,
  visit: Visitor,
  options: WalkOptions = {},
): Promise<void> {
  resolveUnder(approved, dir);
  // The .gitignore files on the path from the root to the directory being
  // read, outermost first: a deeper file's rules refine a shallower one's.
  async function walk(rel: string, ignoreFiles: GitignoreFile[]): Promise<boolean> {
    let entries: Entry[];
    try {
      entries = list(approved, rel);
    } catch {
      return true;
    }
    let scoped = ignoreFiles;
    if (options.respectGitignore) {
      const here = await readGitignore(path.join(approved.real, rel));
      if (here) scoped = [...ignoreFiles, here];
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const entryRel = joinRel(rel, entry.name);
      const full = path.join(approved.real, entryRel);
      if (options.respectGitignore && isIgnored(full, entry.type === "dir", scoped)) continue;
      if (!(await visit(entryRel, entry))) return false;
      if (entry.type === "dir" && !(await walk(entryRel, scoped))) return false;
    }
    return true;
  }
  const start = path.join(approved.real, dir);
  await walk(dir, options.respectGitignore ? await readAncestorGitignores(start) : []);
}

/** Matching lines, or with `filesOnly` just the paths of files that have one. */
export type GrepResults = GrepMatch[] | string[];

/** Search `dir` under `rootDir`. Returned `file` paths are relative to
 *  `dir` so callers can hand them to `read(file, dir)` directly. */
export async function _grep(
  rootDir: string,
  dir: string,
  query: GrepQuery,
  maxResults: number,
  allowedPaths?: string[],
  respectGitignore: boolean = true,
): Promise<GrepResults> {
  const approved = await approvedRoot(rootDir, allowedPaths);
  const plan = compileGrepQuery(query);
  const matches: GrepMatch[] = [];

  await walkDir(
    approved,
    dir,
    async (rel, entry) => {
      if (entry.type !== "file") return true;
      let text: string;
      try {
        text = readText(approved, rel);
      } catch {
        return true;
      }
      const file = relativeTo(dir, rel);
      const perFile = plan.filesOnly ? 1 : maxResults - matches.length;
      for (const hit of firstMatchingLines(text, plan, perFile)) {
        matches.push({ file, ...hit });
      }
      return matches.length < maxResults;
    },
    { respectGitignore },
  );

  return plan.filesOnly ? matches.map((match) => match.file) : matches;
}

type LineHit = { line: number; text: string };

/** Up to `limit` lines of one file that the plan selects, numbered from 1,
 *  scanning no further than it must. A file's final newline does not start
 *  a line, the same as grep, or `invert` would report an empty line past
 *  the end of every file. */
export function firstMatchingLines(text: string, plan: GrepPlan, limit: number): LineHit[] {
  const hits: LineHit[] = [];
  if (text.length === 0) {
    return hits;
  }
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  let start = 0;
  let line = 1;
  while (start <= end && hits.length < limit) {
    const newline = text.indexOf("\n", start);
    const stop = newline === -1 || newline > end ? end : newline;
    const lineText = text.slice(start, stop);
    if (plan.regex.test(lineText) !== plan.invert) {
      hits.push({ line, text: lineText });
    }
    if (stop === end) {
      break;
    }
    start = stop + 1;
    line += 1;
  }
  return hits;
}

/** Glob under `dir` in `rootDir`. Returned paths are relative to `dir`. */
export async function _glob(
  rootDir: string,
  dir: string,
  pattern: string,
  maxResults: number,
  allowedPaths?: string[],
): Promise<string[]> {
  if (maxResults <= 0) return [];
  const approved = await approvedRoot(rootDir, allowedPaths);
  const re = globToRegExp(pattern);
  const results: string[] = [];

  await walkDir(approved, dir, async (rel) => {
    const relToDir = relativeTo(dir, rel);
    if (re.test(relToDir)) {
      results.push(relToDir);
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
        throw new Error(`invalid glob pattern: nested braces are not supported in ${glob}`);
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

const braceAlt: Parser<string> = map(many(noneOf(",}")), (chars: string[]) => chars.join(""));

const braceGroup: Parser<string> = map(
  seqC(char("{"), capture(sepBy(char(","), braceAlt), "alts"), char("}")),
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

const globParser: Parser<string> = map(many(globElement), (parts: string[]) => parts.join(""));

export type StatInfo = {
  exists: boolean;
  type: "file" | "dir" | "symlink" | "other" | "missing";
  size: number;
  modifiedMs: number;
};

/** Probe `target` under `rootDir`. A symlink below the root reports as
 *  missing. The root itself ("." as target) is already real, so a
 *  standalone probe passes the path as `rootDir` and "." as `target`. */
export async function _stat(
  rootDir: string,
  target: string,
  allowedPaths?: string[],
): Promise<StatInfo> {
  const approved = await approvedRoot(rootDir, allowedPaths);
  const info = stat(approved, target);
  if (info === null) {
    return { exists: false, type: "missing", size: 0, modifiedMs: 0 };
  }
  let type: StatInfo["type"] = "other";
  if (info.isDirectory()) type = "dir";
  else if (info.isFile()) type = "file";
  return { exists: true, type, size: info.size, modifiedMs: info.mtimeMs };
}

export async function _exists(
  rootDir: string,
  target: string,
  allowedPaths?: string[],
): Promise<boolean> {
  const approved = await approvedRoot(rootDir, allowedPaths);
  return stat(approved, target) !== null;
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
  const extensions = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
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
