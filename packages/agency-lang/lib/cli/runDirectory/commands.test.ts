import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import { computeCodeIdentity } from "@/runDirectory/codeIdentity.js";
import { recordGradingPass } from "@/runDirectory/mutations.js";
import { readRunDirectory, runDirPaths } from "@/runDirectory/runDir.js";
import {
  agentStartLine,
  statelogLine,
  tempDir,
  writeProject,
} from "@/runDirectory/testFixtures.js";

import { Command } from "@/vendor/commander/index.js";

import { runsAdd } from "./add.js";
import {
  addRunDirectoryCommands,
  runDirectoryCommandDependencies,
  type RunDirectoryCommandDependencies,
} from "./commands.js";
import { formatTextTable } from "./table.js";
import { logsExtract } from "./extract.js";
import { runsList } from "./list.js";

const quiet = { reportWarning: () => {} };

function programWith(deps: Partial<RunDirectoryCommandDependencies>): Command {
  const program = new Command().exitOverride();
  addRunDirectoryCommands(program, { ...runDirectoryCommandDependencies(), ...deps });
  return program;
}

/** A group of two one-run directories, `a` and `b`, as eval run writes them. */
function writeGroup(): { group: string; a: string; b: string } {
  const group = tempDir("group-");
  const a = path.join(group, "a");
  const b = path.join(group, "b");
  const agentLabel = "/abs/agents/greeter.agency:main";
  writeRunDirectory([{ traceId: "ta", test: { id: "a", input: "t" }, output: "x", agentLabel }], a);
  writeRunDirectory([{ traceId: "tb", test: { id: "b", input: "t" }, output: "y", agentLabel }], b);
  return { group, a, b };
}

function lastLine(text: string): string {
  const lines = text.split("\n");
  return lines[lines.length - 1];
}

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

  it("refuses an existing --out unless --overwrite, and never the source log itself", () => {
    const log = statelogFile(agentStartLine("abc123"), agentStartLine("abd456"));
    const out = path.join(tempDir(), "trace.jsonl");
    fs.writeFileSync(out, "precious\n");
    expect(() => logsExtract({ log, trace: "abc", out }, { writeStdout: () => {} })).toThrow(
      /already exists.*--overwrite/,
    );
    expect(fs.readFileSync(out, "utf8")).toBe("precious\n");
    logsExtract({ log, trace: "abc", out, overwrite: true }, { writeStdout: () => {} });
    expect(fs.readFileSync(out, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    const before = fs.readFileSync(log, "utf8");
    expect(() =>
      logsExtract({ log, trace: "abc", out: log, overwrite: true }, { writeStdout: () => {} }),
    ).toThrow(/own source/);
    expect(fs.readFileSync(log, "utf8")).toBe(before);
  });
});

describe("formatTextTable", () => {
  it("paints the header after padding, so columns still line up", () => {
    const text = formatTextTable(["a", "bbb"], [["xxxx", "y"]], (line) => `<${line}>`);
    expect(text).toBe("<a     bbb>\nxxxx  y");
  });
});

describe("runs add", () => {
  it("wraps each trace as <dir>/<traceId>/, attaching matching code, and skips existing children", () => {
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
    expect(first.written).toEqual([path.join(dir, "t1"), path.join(dir, "t2")]);
    expect(fs.existsSync(path.join(dir, "t1", "code", "main.agency"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "t2", "code"))).toBe(false);
    expect(reports[0]).toContain(`wrote ${path.join(dir, "t1")}`);
    const again = runsAdd(
      { dir, statelog: [log], code: [], annotations: [] },
      { report: (message) => reports.push(message) },
    );
    expect(again.written).toEqual([]);
    expect(again.skipped.map((skip) => skip.traceId)).toEqual(["t1", "t2"]);
    expect(reports[1]).toMatch(/skipped t1: .*already exists/);
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
    expect(fs.existsSync(path.join(dir, "t1"))).toBe(false);
  });

  it("attaches a workdir when the statelog holds one trace, and demands --trace otherwise", () => {
    const dir = tempDir();
    const workdir = writeProject({ "out.txt": "x" });
    runsAdd(
      { dir, statelog: [statelogFile(agentStartLine("t1"))], code: [], workdir, annotations: [] },
      { report: () => {} },
    );
    expect(fs.existsSync(path.join(dir, "t1", "workdir", "out.txt"))).toBe(true);
    const two = statelogFile(agentStartLine("t2"), agentStartLine("t3"));
    expect(() =>
      runsAdd({ dir, statelog: [two], code: [], workdir, annotations: [] }, { report: () => {} }),
    ).toThrow(/--trace/);
    runsAdd(
      { dir, statelog: [two], code: [], workdir, trace: "t3", annotations: [] },
      { report: () => {} },
    );
    expect(fs.existsSync(path.join(dir, "t3", "workdir", "out.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "t2"))).toBe(false);
  });
});

describe("runs list NOTES column", () => {
  it("shows yes for a run whose notes.md has text, blank for a blank one", () => {
    const { group, a, b } = writeGroup();
    fs.writeFileSync(runDirPaths(a).notes, "slow\n");
    fs.writeFileSync(runDirPaths(b).notes, "  \n");
    const listed: string[] = [];
    const summaries = runsList([group], { report: (m) => listed.push(m) });
    expect(summaries.map((s) => [s.testId, s.hasNotes])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    const [header, rowA, rowB] = listed[0].split("\n");
    const column = header.indexOf("NOTES");
    expect(rowA.slice(column, column + 5)).toBe("yes  ");
    expect(rowB.slice(column, column + 5)).toBe("     ");
    expect(lastLine(listed[0])).toBe("2 runs");
  });

  it("refuses a folder holding no run directories", () => {
    expect(() => runsList([tempDir()], { report: () => {} })).toThrow(/holds no run directories/);
  });
});

describe("runs list over groups", () => {
  it("lists a group: one row per run, TEST and AGENT columns, footer with the run count", () => {
    const { group, a } = writeGroup();
    const listed: string[] = [];
    const summaries = runsList([group], { report: (m) => listed.push(m) });
    expect(summaries.map((summary) => summary.testId)).toEqual(["a", "b"]);
    const [header, rowA] = listed[0].split("\n");
    expect(header).toContain("TEST");
    expect(header).toContain("AGENT");
    expect(rowA).toContain("a");
    expect(rowA).toContain("/abs/agents/greeter.agency:main");
    expect(lastLine(listed[0])).toBe("2 runs");
    expect(readRunDirectory(a, quiet).traces).toHaveLength(1);
  });

  it("several paths keep the user's order and duplicates; one run directory is a list of one", () => {
    const { group, a } = writeGroup();
    const listed: string[] = [];
    const three = runsList([a, group], { report: (m) => listed.push(m) });
    expect(three.map((summary) => summary.testId)).toEqual(["a", "a", "b"]);
    expect(lastLine(listed[0])).toBe("3 runs");
    const one = runsList([a], { report: (m) => listed.push(m) });
    expect(one.map((summary) => summary.testId)).toEqual(["a"]);
    expect(lastLine(listed[1])).toBe("1 run");
  });

  it("footer: mean over the graded rows, and runs that wrote no trace counted", () => {
    const { group, a } = writeGroup();
    recordGradingPass({
      dir: a,
      scores: [
        {
          traceId: "ta",
          annotator: { kind: "grader", id: "g@1" },
          name: "g",
          score: { kind: "binary", pass: true },
          weight: 1,
          mustPass: false,
        },
      ],
    });
    writeRunDirectory(
      [{ test: { id: "c", input: "t" }, wroteStatelog: false, ended: "error" }],
      path.join(group, "c"),
    );
    const listed: string[] = [];
    const summaries = runsList([group], { report: (m) => listed.push(m) });
    expect(summaries).toHaveLength(2);
    expect(lastLine(listed[0])).toBe("3 runs · mean 1.000 over 1 graded · 1 run wrote no trace");
  });

  it("a group of only silent runs prints no table, just the footer", () => {
    const group = tempDir("group-");
    writeRunDirectory(
      [{ test: { id: "c", input: "t" }, wroteStatelog: false, ended: "error" }],
      path.join(group, "c"),
    );
    const listed: string[] = [];
    expect(runsList([group], { report: (m) => listed.push(m) })).toEqual([]);
    expect(listed[0]).toBe("1 run · 1 run wrote no trace");
  });

  it("the CLI passes every positional path through to the command", async () => {
    const runsListMock = vi.fn(() => []);
    await programWith({ runsList: runsListMock }).parseAsync(["runs", "list", "/a", "/b"], {
      from: "user",
    });
    expect(runsListMock).toHaveBeenCalledWith(["/a", "/b"]);
  });
});
