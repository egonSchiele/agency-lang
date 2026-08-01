import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { logsView, type LogsViewDeps } from "./logsView.js";
import { writeGradedRun, writeMultiTraceStatelog } from "../runsExplorer/testFixtures.js";
import { runRow } from "../runsExplorer/views/viewTestUtils.js";

type Calls = {
  viewed: { file: string; follow: boolean }[];
  explored: { route: string; sourceKinds: string[] }[];
  csvSources: number[];
  stdout: string[];
  errors: string[];
};

function seams(): { deps: LogsViewDeps; calls: Calls } {
  const calls: Calls = { viewed: [], explored: [], csvSources: [], stdout: [], errors: [] };
  const deps: LogsViewDeps = {
    viewFile: async (file, opts) => {
      calls.viewed.push({ file, follow: opts.follow ?? false });
    },
    explorer: async (options) => {
      calls.explored.push({ route: options.route, sourceKinds: options.sources.map((s) => s.kind) });
    },
    loadAll: (sources) => {
      calls.csvSources.push(sources.length);
      return [runRow("r-1")];
    },
    stdout: (text) => {
      calls.stdout.push(text);
    },
    onError: (message) => {
      calls.errors.push(message);
    },
  };
  return { deps, calls };
}

describe("logsView routing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-view-routing-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a sole statelog file goes to the viewer, byte-identically to before", async () => {
    const file = writeMultiTraceStatelog(tmpDir);
    const { deps, calls } = seams();

    await logsView([file], {}, deps);

    expect(calls.viewed).toEqual([{ file, follow: false }]);
    expect(calls.explored).toEqual([]);
  });

  it("a sole '-' preserves the stdin path", async () => {
    const { deps, calls } = seams();

    await logsView(["-"], {}, deps);

    expect(calls.viewed).toEqual([{ file: "-", follow: false }]);
  });

  it("a sole regular file with --follow goes straight to the viewer, even when empty", async () => {
    const empty = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(empty, "");
    const { deps, calls } = seams();

    await logsView([empty], { follow: true }, deps);

    expect(calls.viewed).toEqual([{ file: empty, follow: true }]);
    expect(calls.errors).toEqual([]);
  });

  it("a sole empty file without --follow also goes to the viewer", async () => {
    const empty = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(empty, "");
    const { deps, calls } = seams();

    await logsView([empty], {}, deps);

    expect(calls.viewed).toEqual([{ file: empty, follow: false }]);
  });

  it("a run directory opens the explorer in tests mode", async () => {
    const runDir = writeGradedRun(tmpDir);
    const { deps, calls } = seams();

    await logsView([runDir], {}, deps);

    expect(calls.explored).toEqual([{ route: "runTable", sourceKinds: ["runDir"] }]);
  });

  it("multiple mixed paths open the explorer home table", async () => {
    const runDir = writeGradedRun(tmpDir);
    const file = writeMultiTraceStatelog(tmpDir);
    const { deps, calls } = seams();

    await logsView([runDir, file], {}, deps);

    expect(calls.explored).toEqual([{ route: "explorer", sourceKinds: ["runDir", "statelog"] }]);
  });

  it("--follow errors with directories, multiple paths, or --csv", async () => {
    const runDir = writeGradedRun(tmpDir);
    const file = writeMultiTraceStatelog(tmpDir);

    for (const [files, opts] of [
      [[runDir], { follow: true }],
      [[file, file], { follow: true }],
      [[file], { follow: true, csv: true }],
    ] as const) {
      const { deps, calls } = seams();
      await logsView([...files], { ...opts }, deps);
      expect(calls.errors).toHaveLength(1);
      expect(calls.errors[0]).toContain("--follow");
      expect(calls.viewed).toEqual([]);
      expect(calls.explored).toEqual([]);
    }
  });

  it("--csv drains the loader and prints CSV to stdout without a TUI", async () => {
    const runDir = writeGradedRun(tmpDir);
    const { deps, calls } = seams();

    await logsView([runDir], { csv: true }, deps);

    expect(calls.csvSources).toEqual([1]);
    expect(calls.stdout).toHaveLength(1);
    expect(calls.stdout[0].split("\n")[0]).toContain("agent");
    expect(calls.explored).toEqual([]);
    expect(calls.viewed).toEqual([]);
  });

  it("unmatched paths report the accepted kinds", async () => {
    const junk = path.join(tmpDir, "junk.json");
    fs.writeFileSync(junk, JSON.stringify({ nope: true }));
    const { deps, calls } = seams();

    await logsView([junk], {}, deps);

    expect(calls.errors).toHaveLength(1);
    expect(calls.errors[0]).toContain("statelog");
    expect(calls.errors[0]).toContain("run directory");
  });
});
