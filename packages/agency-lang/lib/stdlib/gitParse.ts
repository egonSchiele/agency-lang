// Parsers for git's machine-readable output. Pure functions (input string ->
// structured data), unit-tested against fixtures and real-git round-trips.
import {
  type ChangeCode, type FileStatus, type GitStatus, type GitLog,
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
