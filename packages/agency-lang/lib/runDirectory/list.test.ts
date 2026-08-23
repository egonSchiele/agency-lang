import { describe, expect, it } from "vitest";

import { completeAnnotation } from "./annotations.js";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";

import {
  annotationSummaryText,
  buildRunsListing,
  displayAgent,
  summarizeEvalRun,
  summarizeRunDirectory,
  summarizeRuns,
} from "./list.js";
import { recordGradingPass } from "./mutations.js";
import { readRunDirectory, runDirPaths } from "./runDir.js";
import { agentStartLine, statelogLine, tempDir } from "./testFixtures.js";
import * as fs from "fs";
import * as path from "path";

const quiet = { reportWarning: () => {} };

function writeStatelog(dir: string, ...lines: string[]): void {
  fs.writeFileSync(path.join(dir, "statelog.jsonl"), lines.join("\n") + "\n");
}

describe("summarizeRuns", () => {
  it("summarizes a finished trace with notes.md and a score", () => {
    const dir = tempDir();
    writeStatelog(
      dir,
      statelogLine("t1", "agentStart", { entryNode: "main", args: {}, input: "summarize x" }),
      statelogLine("t1", "agentEnd", { result: "done", timeTaken: 5 }),
    );
    fs.writeFileSync(runDirPaths(dir).notes, "fine\n");
    recordGradingPass({
      dir,
      scores: [
        {
          traceId: "t1",
          annotator: { kind: "grader", id: "g@1" },
          name: "a",
          score: { kind: "binary", pass: true },
          weight: 1,
          mustPass: false,
        },
        {
          traceId: "t1",
          annotator: { kind: "grader", id: "g@1" },
          name: "b",
          score: { kind: "scalar", value: 0.5 },
          weight: 1,
          mustPass: false,
        },
      ],
    });
    const [first] = summarizeRuns(readRunDirectory(dir, quiet));
    expect(first).toMatchObject({
      traceId: "t1",
      input: "summarize x",
      ended: "ok",
      latestScore: 0.75,
      gradingPasses: 1,
      hasNotes: true,
      labeled: false,
      codeHash: null,
    });
    expect(annotationSummaryText(first)).toBe("notes · score 0.75");

    // A re-grade: the newer pass is the score, and the count says it was not the first.
    recordGradingPass({
      dir,
      scores: [
        {
          traceId: "t1",
          annotator: { kind: "grader", id: "g@2" },
          name: "a",
          score: { kind: "binary", pass: false },
          weight: 1,
          mustPass: false,
        },
      ],
    });
    const [regraded] = summarizeRuns(readRunDirectory(dir, quiet));
    expect(regraded).toMatchObject({ latestScore: 0.25, gradingPasses: 2 });
    expect(annotationSummaryText(regraded)).toBe("notes · score 0.25 (2 passes)");

    const bare = tempDir();
    writeStatelog(bare, statelogLine("t2", "agentStart", { entryNode: "main", args: {} }));
    expect(summarizeRuns(readRunDirectory(bare, quiet))[0]).toMatchObject({
      traceId: "t2",
      input: null,
      ended: "unknown",
      latestScore: null,
      hasNotes: false,
    });
  });

  it("hasNotes: false without notes.md or when it is only whitespace; true with text", () => {
    const dir = tempDir();
    writeStatelog(dir, statelogLine("t1", "agentStart", { entryNode: "main", args: {} }));
    const summary = () => summarizeRuns(readRunDirectory(dir, quiet))[0];
    expect(summary().hasNotes).toBe(false);
    expect(annotationSummaryText(summary())).toBe("");
    fs.writeFileSync(runDirPaths(dir).notes, "  \n\t\n");
    expect(summary().hasNotes).toBe(false);
    fs.writeFileSync(runDirPaths(dir).notes, "step 3 was slow");
    expect(summary().hasNotes).toBe(true);
    expect(annotationSummaryText(summary())).toBe("notes");
  });

  it("reports gates as unknown (null) when a must-pass score is scalar, since its threshold is not on the row", () => {
    const dir = tempDir();
    writeStatelog(
      dir,
      statelogLine("t1", "agentStart", { entryNode: "main", args: {} }),
      statelogLine("t1", "agentEnd", { result: "done", timeTaken: 1 }),
    );
    const score = (name: string, kind: "binary" | "scalar", mustPass: boolean) => ({
      traceId: "t1",
      annotator: { kind: "grader" as const, id: "g@1" },
      name,
      score:
        kind === "binary"
          ? { kind: "binary" as const, pass: true }
          : { kind: "scalar" as const, value: 0.2 },
      weight: 1,
      mustPass,
    });
    recordGradingPass({ dir, scores: [score("a", "binary", true), score("b", "scalar", false)] });
    expect(summarizeRuns(readRunDirectory(dir, quiet))[0].gatesPassed).toBe(true);
    recordGradingPass({ dir, scores: [score("a", "binary", true), score("b", "scalar", true)] });
    expect(summarizeRuns(readRunDirectory(dir, quiet))[0].gatesPassed).toBeNull();
  });

  it("prefers the harness verdict over the trace's own ending", () => {
    const dir = tempDir();
    writeStatelog(dir, agentStartLine("t1"));
    // A run row written directly, as an import would.
    fs.writeFileSync(
      path.join(dir, "annotations.jsonl"),
      JSON.stringify(
        completeAnnotation(
          {
            traceId: "t1",
            annotator: { kind: "harness", id: "eval" },
            kind: "run",
            test: null,
            suite: null,
            ended: "timeout",
            flags: {},
          },
          "2026-08-18T00:00:00Z",
        ),
      ) + "\n",
    );
    expect(summarizeRuns(readRunDirectory(dir, quiet))[0].ended).toBe("timeout");
  });
});

describe("buildRunsListing", () => {
  function runRow(traceId: string, flags: Record<string, string>): string {
    return (
      JSON.stringify(
        completeAnnotation(
          {
            traceId,
            annotator: { kind: "harness", id: "eval" },
            kind: "run",
            test: null,
            suite: null,
            ended: "ok",
            flags,
          },
          "2026-08-18T00:00:00Z",
        ),
      ) + "\n"
    );
  }

  it("counts rows, silent runs, total runs, and the mean over the graded rows, from the snapshots", () => {
    const one = tempDir();
    writeStatelog(one, agentStartLine("t1"));
    const two = tempDir();
    writeStatelog(two, agentStartLine("t2"));
    const graded = tempDir();
    writeStatelog(graded, agentStartLine("t3"));
    recordGradingPass({
      dir: graded,
      scores: [
        {
          traceId: "t3",
          annotator: { kind: "grader", id: "g@1" },
          name: "a",
          score: { kind: "scalar", value: 0.25 },
          weight: 1,
          mustPass: false,
        },
      ],
    });
    // A run that died before its first event: an empty statelog and the
    // harness's run row, as `eval run` leaves it.
    const silent = writeRunDirectory({
      traceId: "t4",
      test: { id: "d", input: "t" },
      wroteStatelog: false,
      ended: "error",
    });

    const listing = buildRunsListing(
      [one, two, graded, silent].map((dir) => readRunDirectory(dir, quiet)),
    );
    expect(listing.summaries.map((summary) => summary.traceId)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(listing.silentRunCount).toBe(1);
    expect(listing.runCount).toBe(4);
    expect(listing.gradedCount).toBe(1);
    expect(listing.meanScore).toBe(0.25);
  });

  it("no graded rows: null mean and zero graded", () => {
    const dir = tempDir();
    writeStatelog(dir, agentStartLine("t1"));
    const listing = buildRunsListing([readRunDirectory(dir, quiet)]);
    expect(listing).toMatchObject({
      runCount: 1,
      silentRunCount: 0,
      gradedCount: 0,
      meanScore: null,
    });
  });

  it("displayAgent: the trace's agentName event wins; else the harness label unchanged; else null", () => {
    const command = "/usr/bin/python /tmp/agent.py --workdir /tmp/data";
    // One run directory per case; the run row's agent label is the harness's.
    const runs: [string, string[], string | null][] = [
      [
        "named",
        [agentStartLine("named"), statelogLine("named", "agentName", { name: "greeter" })],
        "/abs/agents/other.agency:main",
      ],
      ["file", [agentStartLine("file")], "/abs/agents/greeter.agency:main"],
      ["command", [agentStartLine("command")], command],
      ["bare", [agentStartLine("bare")], null],
    ];
    const byTrace: Record<string, string | null> = {};
    for (const [traceId, lines, agent] of runs) {
      const dir = tempDir();
      writeStatelog(dir, ...lines);
      if (agent !== null)
        fs.writeFileSync(path.join(dir, "annotations.jsonl"), runRow(traceId, { agent }));
      const [summary] = summarizeRuns(readRunDirectory(dir, quiet));
      byTrace[traceId] = displayAgent(summary);
    }
    expect(byTrace).toEqual({
      named: "greeter",
      file: "/abs/agents/greeter.agency:main",
      command,
      bare: null,
    });
  });
});

describe("summarizeEvalRun and summarizeRunDirectory", () => {
  it("a finished suite run: batch, trial, event count, status, and the run row's time as endedAt", () => {
    const dir = writeRunDirectory({
      test: { id: "a", input: "t" },
      output: "x",
      costUsd: 0.5,
      batch: "batch-1",
      trial: 2,
    });
    const snapshot = readRunDirectory(dir, quiet);
    const summary = summarizeRunDirectory(snapshot);
    const runRow = snapshot.effectiveAnnotations["trace-1"].run;
    expect(summary).toMatchObject({
      traceId: "trace-1",
      testId: "a",
      batch: "batch-1",
      trial: 2,
      eventCount: 4,
      costUsd: 0.5,
      llmCalls: 1,
      status: "ok",
      ended: "ok",
      endedAt: runRow?.createdAt,
      suiteSource: null,
    });
  });

  it("the canonical-row summary equals the directory summary for the same run", () => {
    const dir = writeRunDirectory({
      test: { id: "a", input: "t" },
      output: "x",
      batch: "batch-1",
      trial: 1,
    });
    fs.writeFileSync(runDirPaths(dir).notes, "fine\n");
    const snapshot = readRunDirectory(dir, quiet);
    const fromRows = summarizeEvalRun({
      traceId: "trace-1",
      events: snapshot.traces[0].events,
      annotations: snapshot.annotationRows,
      source: snapshot.dir,
      notes: snapshot.notes,
    });
    expect(fromRows).toEqual(summarizeRunDirectory(snapshot));
    expect(fromRows.hasNotes).toBe(true);
  });

  it("a run that never wrote a trace is a failed summary with zero metrics, keeping its identity and score", () => {
    const dir = writeRunDirectory({
      traceId: "silent-1",
      test: { id: "a", input: "t" },
      wroteStatelog: false,
      ended: "error",
      errorMessage: "agent crashed at startup",
      batch: "batch-1",
      trial: 3,
    });
    const snapshot = readRunDirectory(dir, quiet);
    const summary = summarizeRunDirectory(snapshot);
    // Grading writes no score row for a run that never ran; its grade is the
    // rule "did not finish scores zero", carried as `score`.
    expect(summary).toMatchObject({
      traceId: "silent-1",
      testId: "a",
      status: "failed",
      ended: "error",
      eventCount: 0,
      costUsd: 0,
      llmCalls: 0,
      toolCalls: 0,
      durationMs: 0,
      startedAt: null,
      models: [],
      latestScore: null,
      score: 0,
      batch: "batch-1",
      trial: 3,
      endedAt: snapshot.effectiveAnnotations["silent-1"].run?.createdAt,
    });
    expect(summarizeRuns(snapshot)).toEqual([summary]);
    const listing = buildRunsListing([snapshot]);
    expect(listing.runCount).toBe(1);
    expect(listing.silentRunCount).toBe(1);
    expect(
      summarizeEvalRun({
        traceId: "silent-1",
        events: [],
        annotations: snapshot.annotationRows,
        source: snapshot.dir,
      }),
    ).toEqual(summary);
  });

  it("score: the effective score for a run that ended ok, 0 for one that did not, null when ungraded", () => {
    const ok = writeRunDirectory({ test: { id: "a", input: "t" }, output: "x" });
    expect(summarizeRunDirectory(readRunDirectory(ok, quiet))).toMatchObject({
      latestScore: null,
      score: null,
    });
    const score = (dir: string) =>
      recordGradingPass({
        dir,
        scores: [
          {
            traceId: "trace-1",
            annotator: { kind: "grader", id: "g@1" },
            name: "a",
            score: { kind: "scalar", value: 0.75 },
            weight: 1,
            mustPass: false,
          },
        ],
      });
    score(ok);
    expect(summarizeRunDirectory(readRunDirectory(ok, quiet))).toMatchObject({
      latestScore: 0.75,
      score: 0.75,
    });
    const killed = writeRunDirectory({
      test: { id: "a", input: "t" },
      output: "x",
      ended: "timeout",
    });
    score(killed);
    expect(summarizeRunDirectory(readRunDirectory(killed, quiet))).toMatchObject({
      status: "killed",
      latestScore: 0.75,
      score: 0,
    });
  });

  it("a trace with no harness row is status trace, ending at its last event", () => {
    const dir = tempDir();
    writeStatelog(
      dir,
      agentStartLine("t1"),
      statelogLine("t1", "agentEnd", { result: "done", timeTaken: 1 }),
    );
    expect(summarizeRunDirectory(readRunDirectory(dir, quiet))).toMatchObject({
      status: "trace",
      ended: "ok",
      endedAt: "2026-08-18T00:00:00Z",
      batch: null,
      trial: null,
    });
  });

  it("an empty directory with no run row is not a run", () => {
    const dir = tempDir();
    writeStatelog(dir);
    expect(summarizeRunDirectory(readRunDirectory(dir, quiet))).toBeNull();
  });

  it("refuses rows of another trace, naming both ids", () => {
    const dir = writeRunDirectory({ traceId: "t1", test: { id: "a", input: "t" }, output: "x" });
    const snapshot = readRunDirectory(dir, quiet);
    expect(() =>
      summarizeEvalRun({
        traceId: "t2",
        events: snapshot.traces[0].events,
        annotations: [],
        source: "x",
      }),
    ).toThrow(/run t2 was given an event of trace t1/);
    expect(() =>
      summarizeEvalRun({
        traceId: "t2",
        events: [],
        annotations: snapshot.annotationRows,
        source: "x",
      }),
    ).toThrow(/run t2 was given an annotation of trace t1/);
  });
});
