import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { computeCodeIdentity } from "@/runDirectory/codeIdentity.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";
import {
  agentStartLine,
  statelogLine,
  tempDir,
  writeProject,
} from "@/runDirectory/testFixtures.js";

import { runsAdd } from "./add.js";
import { logsExtract } from "./extract.js";
import { runsList } from "./list.js";
import { note } from "./note.js";

const quiet = { reportWarning: () => {} };

function statelogFile(...lines: string[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "log-")), "statelog.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("logs extract", () => {
  it("copies the one trace verbatim when the log holds one", () => {
    const first = agentStartLine("abc123");
    const log = statelogFile(first, statelogLine("abc123", "agentEnd", { result: "x" }));
    const out: string[] = [];
    const result = logsExtract({ log }, { writeStdout: (text) => out.push(text) });
    expect(result).toEqual({ traceId: "abc123", lines: 2 });
    expect(out.join("").split("\n")[0]).toBe(first);
  });

  it("needs --trace when several traces exist, and lists them", () => {
    const log = statelogFile(agentStartLine("abc123"), agentStartLine("abd456"));
    expect(() => logsExtract({ log }, { writeStdout: () => {} })).toThrow(/abc123[\s\S]*abd456/);
    const out = path.join(tempDir(), "nested", "trace.jsonl");
    logsExtract({ log, trace: "abd", out }, { writeStdout: () => {} });
    expect(fs.readFileSync(out, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    expect(() => logsExtract({ log, trace: "ab" }, { writeStdout: () => {} })).toThrow(/ambiguous/);
  });
});

describe("runs add", () => {
  it("assembles a directory from a statelog and matching code, idempotently", () => {
    const project = writeProject({ "main.agency": "node main() { return 1 }\n" });
    const entry = path.join(project, "main.agency");
    const log = statelogFile(
      agentStartLine("t1", computeCodeIdentity(entry)),
      agentStartLine("t2"),
    );
    const dir = tempDir();
    const reports: string[] = [];
    const first = runsAdd(
      { dir, statelog: [log], code: [entry], annotations: [] },
      { report: (m) => reports.push(m) },
    );
    expect(first.statelogs).toEqual({ added: 2, skipped: 0 });
    expect(first.code).toEqual({ added: 1, skipped: 0 });
    expect(reports[0]).toContain("2 added");
    const again = runsAdd(
      { dir, statelog: [log], code: [], annotations: [] },
      { report: () => {} },
    );
    expect(again.statelogs).toEqual({ added: 0, skipped: 2 });
  });

  it("refuses code no trace recorded, naming the recorded hash", () => {
    const project = writeProject({ "main.agency": "node main() { return 1 }\n" });
    const other = writeProject({ "main.agency": "node main() { return 2 }\n" });
    const entry = path.join(project, "main.agency");
    const recorded = computeCodeIdentity(entry).closureHash;
    const dir = tempDir();
    expect(() =>
      runsAdd(
        {
          dir,
          statelog: [statelogFile(agentStartLine("t1", computeCodeIdentity(entry)))],
          code: [path.join(other, "main.agency")],
          annotations: [],
        },
        { report: () => {} },
      ),
    ).toThrow(new RegExp(recorded));
    expect(fs.existsSync(runDirPaths(dir).codeDir)).toBe(false);
  });

  it("attaches a workdir to the only trace without --trace, and demands it otherwise", () => {
    const dir = tempDir();
    const workdir = writeProject({ "out.txt": "x" });
    runsAdd(
      { dir, statelog: [statelogFile(agentStartLine("t1"))], code: [], workdir, annotations: [] },
      { report: () => {} },
    );
    expect(fs.existsSync(path.join(runDirPaths(dir).workdirDir, "t1", "out.txt"))).toBe(true);
    runsAdd(
      { dir, statelog: [statelogFile(agentStartLine("t2"))], code: [], annotations: [] },
      { report: () => {} },
    );
    expect(() =>
      runsAdd({ dir, statelog: [], code: [], workdir, annotations: [] }, { report: () => {} }),
    ).toThrow(/--trace/);
  });
});

describe("note and runs list", () => {
  it("notes the only trace, demands --trace with several, and lists counts", () => {
    const dir = tempDir();
    runsAdd(
      { dir, statelog: [statelogFile(agentStartLine("t1"))], code: [], annotations: [] },
      { report: () => {} },
    );
    const deps = { report: vi.fn(), user: () => "adit" };
    const row = note({ dir, text: "too slow" }, deps);
    expect(row.kind).toBe("note");
    expect(readRunDirectory(dir, quiet).effectiveAnnotations.t1.notes).toHaveLength(1);
    expect(() => note({ dir, text: "  " }, deps)).toThrow(/needs some text/);

    runsAdd(
      { dir, statelog: [statelogFile(agentStartLine("t2"))], code: [], annotations: [] },
      { report: () => {} },
    );
    expect(() => note({ dir, text: "x" }, deps)).toThrow(/--trace/);
    note({ dir, text: "second", trace: "t2" }, deps);

    const listed: string[] = [];
    const summaries = runsList(dir, { report: (m) => listed.push(m) });
    expect(summaries.map((s) => [s.traceId, s.noteCount])).toEqual([
      ["t1", 1],
      ["t2", 1],
    ]);
    expect(listed[0]).toContain("TRACE");
    expect(listed[0].split("\n")).toHaveLength(3);
  });

  it("lists an empty directory without failing", () => {
    const listed: string[] = [];
    expect(runsList(tempDir(), { report: (m) => listed.push(m) })).toEqual([]);
    expect(listed[0]).toContain("no traces");
  });
});
