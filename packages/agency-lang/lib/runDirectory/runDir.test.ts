import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { completeAnnotation } from "./annotations.js";
import { readRunDirectory, runDirPaths } from "./runDir.js";
import * as traces from "./traces.js";

function line(traceId: string, type: string): string {
  return JSON.stringify({
    format_version: 1,
    trace_id: traceId,
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: "2026-08-18T00:00:00Z" },
  });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rundir-"));
}

describe("readRunDirectory", () => {
  it("returns an empty valid snapshot for an empty directory", () => {
    const dir = tempDir();
    const snapshot = readRunDirectory(dir, { reportWarning: () => {} });
    expect(snapshot).toEqual({
      dir,
      hasStatelog: false,
      traces: [],
      annotationRows: [],
      effectiveAnnotations: {},
    });
  });

  it("returns traces plus raw and effective annotations", () => {
    const dir = tempDir();
    const paths = runDirPaths(dir);
    fs.writeFileSync(
      paths.statelog,
      line("t1", "agentStart") + "\n" + line("t2", "agentStart") + "\n",
    );
    const note = completeAnnotation(
      { traceId: "t1", annotator: { kind: "human", id: "adit" }, kind: "note", text: "slow" },
      "2026-08-18T00:00:00Z",
    );
    fs.writeFileSync(paths.annotations, JSON.stringify(note) + "\n");
    const snapshot = readRunDirectory(dir, { reportWarning: () => {} });
    expect(snapshot.hasStatelog).toBe(true);
    expect(snapshot.traces.map((trace) => trace.traceId)).toEqual(["t1", "t2"]);
    expect(snapshot.annotationRows).toEqual([note]);
    expect(snapshot.effectiveAnnotations.t1.notes).toEqual([note]);
    expect(snapshot.effectiveAnnotations.t2).toBeUndefined();
  });

  it("re-reads when the statelog changed between its two passes", () => {
    const dir = tempDir();
    const paths = runDirPaths(dir);
    fs.writeFileSync(paths.statelog, line("t1", "agentStart") + "\n");
    const real = traces.readTraces;
    let reads = 0;
    const spy = vi.spyOn(traces, "readTraces").mockImplementation((statelogPath) => {
      reads += 1;
      // A writer appends a trace after the first pass; the snapshot must not
      // pair the old statelog with the newer annotations.
      if (reads === 1) {
        const result = real(statelogPath);
        fs.appendFileSync(paths.statelog, line("t2", "agentStart") + "\n");
        return result;
      }
      return real(statelogPath);
    });
    try {
      const snapshot = readRunDirectory(dir, { reportWarning: () => {} });
      expect(snapshot.traces.map((trace) => trace.traceId)).toEqual(["t1", "t2"]);
      expect(reads).toBeGreaterThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports parse errors as warnings rather than failing", () => {
    const dir = tempDir();
    fs.writeFileSync(runDirPaths(dir).statelog, "not json\n" + line("t1", "agentStart") + "\n");
    const warnings: string[] = [];
    const snapshot = readRunDirectory(dir, { reportWarning: (m) => warnings.push(m) });
    expect(snapshot.traces).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });
});
