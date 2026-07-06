import { describe, it, expect } from "vitest";
import {
  parseStatus, parseLog, splitRecords,
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
