// Pure git helpers: shared types, argv builders, env scrubbing, and output
// parsers. NO mutable module state, NO process spawning, NO fs, NO
// AsyncLocalStorage — everything here is request/response so it is trivially
// unit-testable and safe under Agency's per-run isolation. Path-containment
// (async + symlink-aware) lives in git.ts, not here.
//
// This file currently covers the gitStatus / gitLog / gitCommit slice; the
// remaining builders/parsers are added as the rest of the plan lands.

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
  const out: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(out)) {
    for (const rule of SCRUB_ENV_KEYS) {
      const matches = rule.endsWith("*")
        ? key.startsWith(rule.slice(0, -1))
        : key === rule;
      if (matches) {
        delete out[key];
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Argv builders (one per subcommand). Return the args AFTER the hardening
// flags, i.e. starting with the subcommand. Path-restriction is NOT here
// (moved to the tool layer's assertPathsContained). The --format/--porcelain
// strings live here so stdlib/git.agency never emits one.
// ---------------------------------------------------------------------------

export function statusArgs(): string[] {
  return ["status", "--porcelain=v2", "--branch", "-z"];
}

export function logArgs(o: {
  n: number; oneline: boolean; path: string; ref: string; author: string;
}): string[] {
  const args: string[] = ["log"];
  if (o.n > 0) {
    args.push("-n", String(o.n));
  }
  const fmt = o.oneline
    ? `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}${RECORD_SEP}`
    : `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;
  args.push(fmt);
  if (o.author) {
    args.push(`--author=${o.author}`);
  }
  args.push("--end-of-options");
  if (o.ref) {
    args.push(hardenPositional(o.ref, "ref"));
  }
  if (o.path) {
    args.push("--", hardenPositional(o.path, "path"));
  }
  return args;
}

export function commitArgs(o: { message: string }): string[] {
  if (o.message.length === 0) {
    throw new Error("git: commit message may not be empty");
  }
  return ["commit", "-m", o.message];
}

// ---------------------------------------------------------------------------
// Parsers.
// ---------------------------------------------------------------------------

/** Split RECORD_SEP-delimited output into per-record FIELD_SEP arrays,
 *  dropping git's inter-record newline and blank records. */
export function splitRecords(stdout: string): string[][] {
  return stdout
    .split(RECORD_SEP)
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.trim() !== "")
    .map((rec) => rec.split(FIELD_SEP));
}

function toCode(ch: string): ChangeCode {
  return (ch === " " ? "." : ch) as ChangeCode;
}

// porcelain-v2 record layouts (space-separated fields BEFORE the path):
//   type "1" ordinary:    1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>   -> path at field 8
//   type "2" rename/copy: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>  -> path at field 9 (+ origPath = next NUL token)
//   type "u" unmerged:    u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> -> path at field 10
const ORDINARY_PATH_FIELD = 8;
const RENAME_PATH_FIELD = 9;
const UNMERGED_PATH_FIELD = 10;

export function parseStatus(stdout: string): GitStatus {
  const result: GitStatus = { branch: "", upstream: "", ahead: 0, behind: 0, entries: [] };
  const tokens = stdout.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") {
    tokens.pop(); // trailing empty token after the final NUL (NOT a useless special case)
  }
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (rec.startsWith("# branch.head ")) {
      result.branch = rec.slice("# branch.head ".length);
    } else if (rec.startsWith("# branch.upstream ")) {
      result.upstream = rec.slice("# branch.upstream ".length);
    } else if (rec.startsWith("# branch.ab ")) {
      const m = rec.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        result.ahead = Number(m[1]);
        result.behind = Number(m[2]);
      }
    } else if (rec.startsWith("# ")) {
      // other branch header (branch.oid) — ignore
    } else if (rec.startsWith("1 ")) {
      const parts = rec.split(" ");
      const xy = parts[1];
      result.entries.push({ path: parts.slice(ORDINARY_PATH_FIELD).join(" "), index: toCode(xy[0]), worktree: toCode(xy[1]) });
    } else if (rec.startsWith("2 ")) {
      const parts = rec.split(" ");
      const xy = parts[1];
      const renamedFrom = tokens[i + 1] ?? "";
      i++; // consume the origPath NUL field
      result.entries.push({ path: parts.slice(RENAME_PATH_FIELD).join(" "), index: toCode(xy[0]), worktree: toCode(xy[1]), renamedFrom });
    } else if (rec.startsWith("u ")) {
      result.entries.push({ path: rec.split(" ").slice(UNMERGED_PATH_FIELD).join(" "), index: "U", worktree: "U" });
    } else if (rec.startsWith("? ")) {
      result.entries.push({ path: rec.slice(2), index: "?", worktree: "?" });
    } else if (rec.startsWith("! ")) {
      result.entries.push({ path: rec.slice(2), index: "!", worktree: "!" });
    }
  }
  return result;
}

export function parseLog(stdout: string): GitLog {
  const commits = splitRecords(stdout).map((f) => ({
    sha: f[0] ?? "",
    author: f[1] ?? "",
    email: f[2] ?? "",
    date: f[3] ?? "",
    subject: f[4] ?? "",
    body: (f[5] ?? "").replace(/\n$/, ""),
  }));
  return { commits };
}
