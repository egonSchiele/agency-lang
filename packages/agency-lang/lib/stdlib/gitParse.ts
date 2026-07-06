// Parsers for git's machine-readable output. Pure functions (input string ->
// structured data), unit-tested against fixtures and real-git round-trips.
//
// Delimiter-framed formats (status -z, log/branch via %x1f/%x1e, blame/remote/
// stash) parse with String.split — that framing is designed for unambiguous
// splitting. The unified diff is a real line-grammar, so parseDiff uses tarsec.
import {
  str, capture, map, many, seqC, optional, newline, noneOf, not, eof,
  manyWithJoin, type Parser,
} from "tarsec";
import {
  type ChangeCode, type FileStatus, type GitStatus, type GitLog,
  type FileDiff, type GitDiff, type GitBranch, type BlameLine,
  type GitRemote, type GitStash,
  FIELD_SEP, RECORD_SEP,
} from "./gitCore.js";

/**
 * Split RECORD_SEP-delimited output into one object per record, keyed by the
 * given field names (in order). Drops git's inter-record newline and blank
 * records. Missing trailing fields become "". Returning named objects means
 * callers read `record.sha` instead of guessing what `parts[0]` is.
 */
export function splitRecords(
  stdout: string,
  fieldNames: readonly string[],
): Record<string, string>[] {
  return stdout
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const values = record.split(FIELD_SEP);
      const fields: Record<string, string> = {};
      fieldNames.forEach((name, index) => {
        fields[name] = values[index] ?? "";
      });
      return fields;
    });
}

/** Non-blank lines of newline-delimited output. */
export function nonEmptyLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

const LOG_FIELDS = ["sha", "author", "email", "date", "subject", "body"] as const;

export function parseLog(stdout: string): GitLog {
  const commits = splitRecords(stdout, LOG_FIELDS).map((fields) => ({
    sha: fields.sha,
    author: fields.author,
    email: fields.email,
    date: fields.date,
    subject: fields.subject,
    body: fields.body.replace(/\n$/, ""),
  }));
  return { commits };
}

const BRANCH_FIELDS = ["name", "head", "upstream", "sha"] as const;

export function parseBranchList(stdout: string): GitBranch[] {
  return splitRecords(stdout, BRANCH_FIELDS).map((fields) => ({
    name: fields.name,
    current: fields.head.trim() === "*", // %(HEAD) is "*" for the current branch
    upstream: fields.upstream,
    sha: fields.sha,
  }));
}

export function parseRemoteList(stdout: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  for (const line of nonEmptyLines(stdout)) {
    // "origin\t<url> (fetch)" / "origin\t<url> (push)"
    const match = line.match(/^(\S+)\t(.*)\s+\((fetch|push)\)$/);
    if (match) {
      remotes.push({ name: match[1], url: match[2], direction: match[3] as "fetch" | "push" });
    }
  }
  return remotes;
}

export function parseStashList(stdout: string): GitStash[] {
  const stashes: GitStash[] = [];
  for (const line of nonEmptyLines(stdout)) {
    const separator = line.indexOf(": ");
    if (separator === -1) {
      stashes.push({ ref: line, description: "" });
    } else {
      stashes.push({ ref: line.slice(0, separator), description: line.slice(separator + 2) });
    }
  }
  return stashes;
}

// --- git blame --porcelain -------------------------------------------------
// Each line is a header block ("<sha> <origLine> <finalLine> ...", then
// "author <name>", ...) followed by the content line prefixed with a tab.

export function parseBlame(stdout: string): BlameLine[] {
  const blameLines: BlameLine[] = [];
  let sha = "";
  let author = "";
  let finalLineNumber = 0;
  for (const line of stdout.split("\n")) {
    if (/^[0-9a-f]{7,40} \d+ \d+/.test(line)) {
      const fields = line.split(" ");
      sha = fields[0];
      finalLineNumber = Number(fields[2]);
    } else if (line.startsWith("author ")) {
      author = line.slice("author ".length);
    } else if (line.startsWith("\t")) {
      blameLines.push({ sha, author, line: finalLineNumber, content: line.slice(1) });
    }
  }
  return blameLines;
}

// --- git status --porcelain=v2 -z ------------------------------------------

// A porcelain code is a single character; " " means "unmodified" (we surface
// it as ".").
function toChangeCode(character: string): ChangeCode {
  return (character === " " ? "." : character) as ChangeCode;
}

// Field index (0-based, space-separated) at which the path begins, per record
// type. Everything before it is fixed metadata we don't surface.
//   "1" ordinary:    1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//   "2" rename/copy: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>   (+ origPath = next NUL token)
//   "u" unmerged:    u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
const ORDINARY_PATH_FIELD = 8;
const RENAME_PATH_FIELD = 9;
const UNMERGED_PATH_FIELD = 10;

// "# branch.head <name>" / "# branch.upstream <name>" / "# branch.ab +A -B".
function applyBranchHeader(record: string, status: GitStatus): void {
  if (record.startsWith("# branch.head ")) {
    status.branch = record.slice("# branch.head ".length);
  } else if (record.startsWith("# branch.upstream ")) {
    status.upstream = record.slice("# branch.upstream ".length);
  } else if (record.startsWith("# branch.ab ")) {
    const aheadBehind = record.match(/\+(\d+)\s+-(\d+)/);
    if (aheadBehind) {
      status.ahead = Number(aheadBehind[1]);
      status.behind = Number(aheadBehind[2]);
    }
  }
  // Other headers (e.g. "# branch.oid") carry nothing we surface.
}

function parseOrdinaryEntry(record: string): FileStatus {
  const fields = record.split(" ");
  const [indexCode, worktreeCode] = fields[1];
  return {
    path: fields.slice(ORDINARY_PATH_FIELD).join(" "),
    index: toChangeCode(indexCode),
    worktree: toChangeCode(worktreeCode),
  };
}

function parseRenameEntry(record: string, renamedFrom: string): FileStatus {
  const fields = record.split(" ");
  const [indexCode, worktreeCode] = fields[1];
  return {
    path: fields.slice(RENAME_PATH_FIELD).join(" "),
    index: toChangeCode(indexCode),
    worktree: toChangeCode(worktreeCode),
    renamedFrom,
  };
}

function parseUnmergedEntry(record: string): FileStatus {
  const fields = record.split(" ");
  return {
    path: fields.slice(UNMERGED_PATH_FIELD).join(" "),
    index: "U",
    worktree: "U",
  };
}

export function parseStatus(stdout: string): GitStatus {
  const status: GitStatus = { branch: "", upstream: "", ahead: 0, behind: 0, entries: [] };
  const records = stdout.split("\0");
  if (records.length > 0 && records[records.length - 1] === "") {
    records.pop(); // trailing empty token after the final NUL
  }
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# ")) {
      applyBranchHeader(record, status);
    } else if (record.startsWith("1 ")) {
      status.entries.push(parseOrdinaryEntry(record));
    } else if (record.startsWith("2 ")) {
      const renamedFrom = records[i + 1] ?? "";
      i++; // consume the origPath NUL token that follows a rename record
      status.entries.push(parseRenameEntry(record, renamedFrom));
    } else if (record.startsWith("u ")) {
      status.entries.push(parseUnmergedEntry(record));
    } else if (record.startsWith("? ")) {
      status.entries.push({ path: record.slice(2), index: "?", worktree: "?" });
    } else if (record.startsWith("! ")) {
      status.entries.push({ path: record.slice(2), index: "!", worktree: "!" });
    }
  }
  return status;
}

// --- git diff --patch (unified diff) via tarsec ----------------------------
// tarsec frames the per-file blocks (robust boundary handling at each
// "diff --git" line); a pure fold (summarizeFile) derives status + counts.

// The rest of the current line as a string (newline NOT consumed).
const restOfLine: Parser<string> = manyWithJoin(noneOf("\n"));

// "diff --git a/<x> b/<y>" header -> the b/ side (the path). `.*` is greedy: a
// filename literally containing " b/" is mis-split, but git quotes such paths,
// so this is a known low-risk edge, not a v1 goal.
const diffGitLine: Parser<string> = map(
  seqC(str("diff --git "), capture(restOfLine, "header"), optional(newline)),
  (captured: { header: string }) => {
    const bSide = captured.header.match(/ b\/(.*)$/);
    return bSide ? bSide[1] : "";
  },
);

// Any line that does NOT begin a new file block. `not(eof)` prevents a
// zero-consumption success at end-of-input (which would spin `many` forever).
const bodyLine: Parser<string> = map(
  seqC(not(eof), not(str("diff --git ")), capture(restOfLine, "line"), optional(newline)),
  (captured: { line: string }) => captured.line,
);

// One file block: its "diff --git" header + all following body lines.
const fileBlock: Parser<FileDiff> = map(
  seqC(capture(diffGitLine, "path"), capture(many(bodyLine), "lines")),
  (captured: { path: string; lines: string[] }) => summarizeFile(captured.path, captured.lines),
);

// `many` yields [] for empty/non-matching input, so parseDiff("") -> {files:[]}
// needs no special-case guard.
const patchParser: Parser<FileDiff[]> = many(fileBlock);

// Pure fold over one file block's captured lines. Counting `+`/`-` is a fold,
// not a grammar concern, so it stays plain. Merge commits produce a combined
// diff (`diff --cc`, `@@@`, `++`/`--`) this miscounts — documented in gitShow.
function summarizeFile(path: string, lines: string[]): FileDiff {
  let status: ChangeCode = "M";
  let additions: number | null = 0;
  let deletions: number | null = 0;
  let finalPath = path;
  for (const line of lines) {
    if (line.startsWith("new file mode")) {
      status = "A";
    } else if (line.startsWith("deleted file mode")) {
      status = "D";
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      status = "R";
    } else if (line.startsWith("Binary files")) {
      additions = null;
      deletions = null;
    } else if (line.startsWith("+++ b/")) {
      finalPath = line.slice("+++ b/".length);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (additions !== null) {
        additions = additions + 1;
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (deletions !== null) {
        deletions = deletions + 1;
      }
    }
  }
  return { path: finalPath, status, additions, deletions };
}

export function parseDiff(patch: string): GitDiff {
  const parsed = patchParser(patch);
  // tarsec result: { success, rest, result }. Degrade to [] rather than throw.
  const files = parsed.success ? (parsed.result as FileDiff[]) : [];
  return { files, patch };
}
