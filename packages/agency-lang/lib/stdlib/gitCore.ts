// Pure git helpers: shared types, argv builders, and validators. NO mutable
// module state, NO process spawning, NO fs, NO AsyncLocalStorage — everything
// here is request/response so it is trivially unit-testable and safe under
// Agency's per-run isolation. The output parsers live in gitParse.ts;
// path-containment (async + symlink-aware) lives in git.ts.

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

/** The path of every file listed in a git status, in status order. Agency code
  cannot destructure the TS-imported `GitStatus` (its record fields are opaque
  to the Agency typechecker), so this pure helper does the `entries -> paths`
  projection in TS. Untracked new files are included (they are what a coding
  agent just wrote); deleted paths are also included, so a caller that reads
  them should fail open on a missing file. */
export function changedFilePaths(status: GitStatus): string[] {
  return status.entries.map((entry) => entry.path);
}
export type GitCommit = {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
};
export type GitLog = { commits: GitCommit[] };
export type FileDiff = {
  path: string;
  status: ChangeCode;
  additions: number | null; // null for binary files
  deletions: number | null;
};
export type GitDiff = { files: FileDiff[]; patch: string };
export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string;
  sha: string;
};
export type BlameLine = {
  sha: string;
  author: string;
  line: number;
  content: string;
};
export type GitRemote = { name: string; url: string; direction: "fetch" | "push" };
export type GitStash = { ref: string; description: string };

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

/**
 * Reject an operation on a protected branch (e.g. main/master). Empty list =
 * no restriction. Bound via `.partial(protectedBranches: [...])`. Pure string
 * comparison, so it stays here rather than in the async git.ts layer.
 */
export function assertBranchAllowed(branch: string, protectedBranches: string[]): void {
  if (protectedBranches.includes(branch)) {
    throw new Error(`git: branch "${branch}" is protected and may not be modified`);
  }
}

/** Config flags prepended to every git invocation (before the subcommand). */
export const GIT_HARDENING_FLAGS: string[] = [
  "-c", "core.pager=cat",
  "-c", "core.fsmonitor=false",
  "--no-optional-locks",
];

// Env vars we strip before invoking git. Two classes:
//   (a) command-execution vectors (run arbitrary code / load attacker config)
//   (b) repo/worktree overrides that would retarget git away from `cwd` —
//       these would defeat the explicit-cwd contract AND allowedPaths
//       containment (which resolves against cwd, not an overridden work tree).
// A trailing "*" matches any var starting with that prefix.
const SCRUB_ENV_KEYS: string[] = [
  // (a) code execution / config injection
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_PROXY_COMMAND",
  "GIT_EXEC_PATH",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ATTR_SOURCE",
  "GIT_CONFIG*", // GIT_CONFIG, GIT_CONFIG_GLOBAL/SYSTEM, GIT_CONFIG_COUNT/KEY_n/VALUE_n
  // (b) repo / worktree retargeting
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
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

export function diffArgs(opts: {
  ref: string; ref2: string; staged: boolean; path: string;
}): string[] {
  const args: string[] = ["diff", "--patch", "-M"];
  if (opts.staged) {
    args.push("--staged");
  }
  args.push("--end-of-options");
  if (opts.ref) {
    args.push(hardenPositional(opts.ref, "ref"));
  }
  if (opts.ref2) {
    args.push(hardenPositional(opts.ref2, "ref2"));
  }
  if (opts.path) {
    args.push("--", hardenPositional(opts.path, "path"));
  }
  return args;
}

export function showArgs(opts: { ref: string }): string[] {
  const args: string[] = ["show", "--patch", "-M", "--end-of-options"];
  if (opts.ref) {
    args.push(hardenPositional(opts.ref, "ref"));
  }
  return args;
}

export function branchListArgs(): string[] {
  return [
    "for-each-ref",
    `--format=%(refname:short)${FIELD_SEP}%(HEAD)${FIELD_SEP}%(upstream:short)${FIELD_SEP}%(objectname)${RECORD_SEP}`,
    "refs/heads",
  ];
}

export function remoteListArgs(): string[] {
  return ["remote", "-v"];
}

export function blameArgs(opts: { path: string; ref: string }): string[] {
  // --line-porcelain (not --porcelain): repeats the author block on EVERY
  // line, so a non-contiguous line from an already-seen commit is still
  // attributed correctly (plain --porcelain omits it after first sighting).
  // NOTE: `git blame` (unlike log/diff/show) rejects `--end-of-options`
  // followed by `--`, so we omit it here. The ref is still guarded by
  // hardenPositional (leading "-" rejected) and the path sits after `--`.
  const args: string[] = ["blame", "--line-porcelain"];
  if (opts.ref) {
    args.push(hardenPositional(opts.ref, "ref"));
  }
  args.push("--", hardenPositional(opts.path, "path"));
  return args;
}

export function stashListArgs(): string[] {
  return ["stash", "list"];
}

export function addArgs(opts: { paths: string[]; all: boolean }): string[] {
  if (opts.all) {
    return ["add", "-A"];
  }
  const hardened = opts.paths.map((p) => hardenPositional(p, "path"));
  return ["add", "--", ...hardened];
}

export function commitArgs(opts: { message: string }): string[] {
  if (opts.message.length === 0) {
    throw new Error("git: commit message may not be empty");
  }
  return ["commit", "-m", opts.message];
}

export function checkoutArgs(opts: { target: string; force: boolean }): string[] {
  const args: string[] = ["checkout"];
  if (opts.force) {
    args.push("--force");
  }
  args.push("--end-of-options", hardenPositional(opts.target, "target"));
  return args;
}

export function switchArgs(opts: { branch: string; create: boolean }): string[] {
  const args: string[] = ["switch"];
  if (opts.create) {
    args.push("-c");
  }
  args.push("--end-of-options", hardenPositional(opts.branch, "branch"));
  return args;
}

export function branchCreateArgs(opts: { branch: string }): string[] {
  return ["branch", "--end-of-options", hardenPositional(opts.branch, "branch")];
}

export function branchDeleteArgs(opts: {
  branch: string; force: boolean; protectedBranches: string[];
}): string[] {
  assertBranchAllowed(opts.branch, opts.protectedBranches);
  const flag = opts.force ? "-D" : "-d";
  return ["branch", flag, "--end-of-options", hardenPositional(opts.branch, "branch")];
}

export function stashPushArgs(opts: { message: string }): string[] {
  const args: string[] = ["stash", "push"];
  if (opts.message) {
    args.push("-m", opts.message);
  }
  return args;
}

export function stashPopArgs(): string[] {
  return ["stash", "pop"];
}

export function restoreArgs(opts: { paths: string[]; staged: boolean }): string[] {
  const args: string[] = ["restore"];
  if (opts.staged) {
    args.push("--staged");
  }
  const hardened = opts.paths.map((p) => hardenPositional(p, "path"));
  args.push("--", ...hardened);
  return args;
}
