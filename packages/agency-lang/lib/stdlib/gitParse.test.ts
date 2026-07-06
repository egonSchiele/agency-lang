import { describe, it, expect } from "vitest";
import {
  parseStatus, parseLog, parseBranchList, parseBlame, parseRemoteList,
  parseStashList, parseDiff, splitRecords,
  FIELD_SEP as FS, RECORD_SEP as RS,
} from "./git.js";

describe("splitRecords", () => {
  it("returns objects keyed by field name, tolerating git's inter-record newline", () => {
    const out =
      ["a", "b", "c"].join(FS) + RS + "\n" +
      ["d", "e"].join(FS) + RS + "\n"; // missing 3rd field -> ""
    expect(splitRecords(out, ["one", "two", "three"])).toEqual([
      { one: "a", two: "b", three: "c" },
      { one: "d", two: "e", three: "" },
    ]);
  });
  it("returns [] for empty input", () => {
    expect(splitRecords("", ["one"])).toEqual([]);
  });
});

describe("parseStatus", () => {
  it("parses branch headers, modified/added, a space-in-path, a rename, an unmerged record, and untracked", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 hhh iii src/mod.ts",
      "1 A. N... 000000 100644 100644 000 jjj my file.ts",   // space in path
      "2 R. N... 100644 100644 100644 kkk lll R100 dst.ts",
      "old.ts",                                              // origPath NUL field
      "u UU N... 100644 100644 100644 100644 m1 m2 m3 conflict.ts",
      "? untracked.ts",
    ].join("\0") + "\0";
    const status = parseStatus(out);
    expect(status.branch).toBe("main");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.entries).toContainEqual({ path: "src/mod.ts", index: ".", worktree: "M" });
    expect(status.entries).toContainEqual({ path: "my file.ts", index: "A", worktree: "." });
    expect(status.entries).toContainEqual({ path: "dst.ts", index: "R", worktree: ".", renamedFrom: "old.ts" });
    expect(status.entries).toContainEqual({ path: "conflict.ts", index: "U", worktree: "U" });
    expect(status.entries).toContainEqual({ path: "untracked.ts", index: "?", worktree: "?" });
    expect(status.entries).toHaveLength(5);
  });
});

describe("parseLog", () => {
  it("parses commits with multi-line bodies; tolerates git's inter-record newline", () => {
    const record = (fields: string[]) => fields.join(FS);
    const out =
      record(["sha1", "Amy", "amy@x.com", "2026-01-01T00:00:00Z", "subj one", "body\nline2"]) + RS + "\n" +
      record(["sha2", "Bob", "bob@x.com", "2026-01-02T00:00:00Z", "subj two", ""]) + RS + "\n";
    const log = parseLog(out);
    expect(log.commits).toHaveLength(2);
    expect(log.commits[0]).toEqual({
      sha: "sha1", author: "Amy", email: "amy@x.com",
      date: "2026-01-01T00:00:00Z", subject: "subj one", body: "body\nline2",
    });
    expect(log.commits[1].body).toBe("");
  });
  it("returns no commits for empty output", () => {
    expect(parseLog("").commits).toEqual([]);
  });
});

describe("parseBranchList", () => {
  it("marks current, captures upstream + sha; asserts full array", () => {
    const out =
      ["main", "*", "origin/main", "aaa"].join(FS) + RS + "\n" +
      ["feature/x", " ", "", "bbb"].join(FS) + RS + "\n";
    expect(parseBranchList(out)).toEqual([
      { name: "main", current: true, upstream: "origin/main", sha: "aaa" },
      { name: "feature/x", current: false, upstream: "", sha: "bbb" },
    ]);
  });
});

describe("parseBlame", () => {
  it("pairs each porcelain header (real hex sha) with its content line", () => {
    const out = [
      "1a2b3c4d5e6f7a8b 1 1 1", "author Amy", "\tconst x = 1",
      "9f8e7d6c5b4a3210 2 2 1", "author Bob", "\tconst y = 2",
    ].join("\n") + "\n";
    expect(parseBlame(out)).toEqual([
      { sha: "1a2b3c4d5e6f7a8b", author: "Amy", line: 1, content: "const x = 1" },
      { sha: "9f8e7d6c5b4a3210", author: "Bob", line: 2, content: "const y = 2" },
    ]);
  });
});

describe("parseRemoteList", () => {
  it("parses name/url/direction", () => {
    const out = "origin\tgit@x:y.git (fetch)\norigin\tgit@x:y.git (push)\n";
    expect(parseRemoteList(out)).toEqual([
      { name: "origin", url: "git@x:y.git", direction: "fetch" },
      { name: "origin", url: "git@x:y.git", direction: "push" },
    ]);
  });
});

describe("parseStashList", () => {
  it("splits ref from description", () => {
    const out = "stash@{0}: WIP on main: abc msg\nstash@{1}: On main: other\n";
    expect(parseStashList(out)).toEqual([
      { ref: "stash@{0}", description: "WIP on main: abc msg" },
      { ref: "stash@{1}", description: "On main: other" },
    ]);
  });
});

describe("parseDiff (tarsec)", () => {
  it("derives status + counts across modified, deleted, renamed, text-new, and binary files", () => {
    const patch = [
      "diff --git a/mod.ts b/mod.ts",
      "index 111..222 100644",
      "--- a/mod.ts", "+++ b/mod.ts",
      "@@ -1,2 +1,3 @@", " ctx", "-old", "+new1", "+new2",
      "@@ -10 +11,2 @@", " ctx2", "+another",        // second hunk (multi-hunk)
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts", "+++ /dev/null",
      "@@ -1 +0,0 @@", "-bye",
      "diff --git a/moved.ts b/moved2.ts",
      "similarity index 100%", "rename from moved.ts", "rename to moved2.ts",
      "diff --git a/fresh.ts b/fresh.ts",
      "new file mode 100644", "--- /dev/null", "+++ b/fresh.ts",
      "@@ -0,0 +1,2 @@", "+a", "+b",
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "Binary files /dev/null and b/logo.png differ",
    ].join("\n") + "\n";
    const diff = parseDiff(patch);
    expect(diff.patch).toBe(patch);
    expect(diff.files).toContainEqual({ path: "mod.ts", status: "M", additions: 3, deletions: 1 });
    expect(diff.files).toContainEqual({ path: "gone.ts", status: "D", additions: 0, deletions: 1 });
    expect(diff.files).toContainEqual({ path: "moved2.ts", status: "R", additions: 0, deletions: 0 });
    expect(diff.files).toContainEqual({ path: "fresh.ts", status: "A", additions: 2, deletions: 0 });
    expect(diff.files).toContainEqual({ path: "logo.png", status: "A", additions: null, deletions: null });
    expect(diff.files).toHaveLength(5);
  });
  it("returns no files for an empty diff (no special-case guard)", () => {
    expect(parseDiff("")).toEqual({ files: [], patch: "" });
  });
});
