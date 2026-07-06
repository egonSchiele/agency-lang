// Pure git helpers: shared types, argv builders, and env scrubbing. NO mutable
// module state, NO process spawning, NO fs, NO AsyncLocalStorage — everything
// here is request/response so it is trivially unit-testable and safe under
// Agency's per-run isolation. The output parsers live in gitParse.ts;
// path-containment (async + symlink-aware) lives in git.ts.
//
// This file currently covers the gitStatus / gitLog / gitCommit slice; the
// remaining builders are added as the rest of the plan lands.

// git's porcelain change codes are a closed set:
//   "." = unmodified          "M" = modified
//   "A" = added               "D" = deleted
//   "R" = renamed             "C" = copied
//   "U" = unmerged (conflict) "T" = type changed (e.g. file -> symlink)
//   "?" = untracked           "!" = ignored
export type ChangeCode = "." | "M" | "A" | "D" | "R" | "C" | "U" | "T" | "?" | "!";

export type FileStatus = {
  path: string;
  index: ChangeCode;
  worktree: ChangeCode;
  renamedFrom?: string;
};
export type GitStatus = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  entries: FileStatus[];
};
export type GitCommit = {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
};
export type GitLog = { commits: GitCommit[] };

// Record/field separators for our custom --format strings. These bytes are
// practically never present in paths or commit messages, so splitting on them
// is effectively unambiguous. (Git technically permits arbitrary bytes in a
// commit message; the parsers degrade gracefully — extra fields are ignored —
// rather than crash.)
export const FIELD_SEP = "\x1f"; // %x1f
export const RECORD_SEP = "\x1e"; // %x1e

/**
 * Guard a user-supplied positional (ref, path, branch) before it becomes an
 * argv element. A value beginning with "-" would be parsed by git as an option
 * (e.g. `--output=`), so reject it. Callers still place these after
 * `--end-of-options` / `--` in the argv; this is the second, belt-and-braces
 * layer. NOTE: this also rejects legitimate filenames that start with "-"
 * (e.g. "-foo.txt"); the tool `@param`s document that limitation.
 */
export function hardenPositional(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`git: empty ${label} is not allowed`);
  }
  if (value.startsWith("-")) {
    throw new Error(
      `git: ${label} "${value}" may not start with "-" (looks like a flag)`,
    );
  }
  return value;
}

/** Config flags prepended to every git invocation (before the subcommand). */
export const GIT_HARDENING_FLAGS: string[] = [
  "-c", "core.pager=cat",
  "-c", "core.fsmonitor=false",
  "--no-optional-locks",
];

// Env vars that let git run arbitrary commands or load attacker config.
// A trailing "*" matches any var starting with that prefix.
const SCRUB_ENV_KEYS: string[] = [
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_PROXY_COMMAND",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG*", // GIT_CONFIG, GIT_CONFIG_GLOBAL/SYSTEM, GIT_CONFIG_COUNT/KEY_n/VALUE_n
];

/** Shallow copy of `base` with git command-injection vars removed. */
export function scrubEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(scrubbed)) {
    for (const rule of SCRUB_ENV_KEYS) {
      const matches = rule.endsWith("*")
        ? key.startsWith(rule.slice(0, -1))
        : key === rule;
      if (matches) {
        delete scrubbed[key];
        break;
      }
    }
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------
// Argv builders (one per subcommand). Return the args AFTER the hardening
// flags, i.e. starting with the subcommand. Path-restriction is NOT here
// (moved to the tool layer's assertPathsContained). The --format/--porcelain
// strings live here so stdlib/git.agency never emits one.
//
// git --format placeholders used below:
//   %H = full commit hash        %an = author name    %ae = author email
//   %aI = author date (ISO-8601) %s  = subject         %b  = body
//   %x1f / %x1e = the field / record separator bytes (FIELD_SEP / RECORD_SEP).
// ---------------------------------------------------------------------------

export function statusArgs(): string[] {
  return ["status", "--porcelain=v2", "--branch", "-z"];
}

export function logArgs(opts: {
  count: number; oneline: boolean; path: string; ref: string; author: string;
}): string[] {
  const args: string[] = ["log"];
  if (opts.count > 0) {
    args.push("-n", String(opts.count));
  }
  const format = opts.oneline
    ? `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}${RECORD_SEP}`
    : `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;
  args.push(format);
  if (opts.author) {
    args.push(`--author=${opts.author}`);
  }
  args.push("--end-of-options");
  if (opts.ref) {
    args.push(hardenPositional(opts.ref, "ref"));
  }
  if (opts.path) {
    args.push("--", hardenPositional(opts.path, "path"));
  }
  return args;
}

export function commitArgs(opts: { message: string }): string[] {
  if (opts.message.length === 0) {
    throw new Error("git: commit message may not be empty");
  }
  return ["commit", "-m", opts.message];
}
