import { describe, expect, it } from "vitest";

import { completeAnnotation, type Annotation, type AnnotationDraft } from "./annotations.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

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

  it("score: the effective score when graded, 0 for an ungraded run that did not end ok, null when ungraded", () => {
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
      score: 0.75,
    });
  });

  it("a timed-out run keeps the score it was given", () => {
    const dir = writeRunDirectory({ test: { id: "a", input: "t" }, output: "x", ended: "timeout" });
    recordGradingPass({
      dir,
      scores: [
        {
          traceId: "trace-1",
          annotator: { kind: "grader", id: "g@1" },
          name: "reward",
          score: { kind: "binary", pass: true },
          weight: 1,
          mustPass: false,
        },
      ],
    });
    expect(summarizeRunDirectory(readRunDirectory(dir, quiet))).toMatchObject({
      ended: "timeout",
      score: 1,
    });
  });

  it("an ungraded run that didn't end ok still scores 0", () => {
    const dir = writeRunDirectory({ test: { id: "a", input: "t" }, output: "x", ended: "error" });
    expect(summarizeRunDirectory(readRunDirectory(dir, quiet))).toMatchObject({
      ended: "error",
      latestScore: null,
      score: 0,
    });
  });

  it("a void run has no score", () => {
    const dir = writeRunDirectory({
      traceId: "silent-1",
      test: { id: "a", input: "t" },
      wroteStatelog: false,
      ended: "void",
    });
    expect(summarizeRunDirectory(readRunDirectory(dir, quiet))).toMatchObject({
      ended: "void",
      status: "failed",
      score: null,
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

describe("usage and benchmark on the run summary", () => {
  const traceId = "usage-1";

  function completion(
    model: string,
    reasoningEffort: string | null,
    input: number,
    cost: number,
  ): string {
    return statelogLine(traceId, "promptCompletion", {
      model: JSON.stringify(model),
      reasoningEffort,
      usage: {
        inputTokens: input,
        cachedInputTokens: 2 * input,
        cacheCreationInputTokens: 1,
        outputTokens: 3,
      },
      cost: { totalCost: cost },
    });
  }

  const events: EventEnvelope[] = [
    agentStartLine(traceId),
    completion("opus", "high", 100, 0.5),
    completion("opus", "high", 50, 0.25),
    completion("jev", null, 10, 0.125),
  ].map((line) => JSON.parse(line) as EventEnvelope);

  function runRow(fields: Partial<AnnotationDraft> = {}): Annotation {
    return completeAnnotation(
      {
        traceId,
        annotator: { kind: "harness", id: "agency-eval@1" },
        kind: "run",
        test: { id: "a" },
        suite: null,
        ended: "ok",
        flags: {},
        ...fields,
      } as AnnotationDraft,
      "2026-08-18T00:00:09Z",
    );
  }

  function summarize(fields: Partial<AnnotationDraft> = {}) {
    return summarizeEvalRun({ traceId, events, annotations: [runRow(fields)], source: "x" });
  }

  it("models is the run's usage by model and level, with token totals", () => {
    const summary = summarize();
    expect(summary.models.map((item) => [item.name, item.reasoning, item.calls])).toEqual([
      ["jev", null, 1],
      ["opus", "high", 2],
    ]);
    expect(summary.inputTokens).toBe(160);
    expect(summary.cachedInputTokens).toBe(320);
    expect(summary.cacheCreationInputTokens).toBe(3);
    expect(summary.outputTokens).toBe(9);
  });

  it("the run's totals add up", () => {
    const summary = summarize();
    const calls = summary.models.reduce((total, item) => total + item.calls, 0);
    const cost = summary.models.reduce((total, item) => total + item.costUsd, 0);
    expect(calls).toBe(summary.llmCalls);
    expect(cost).toBe(summary.costUsd);
  });

  it("benchmark comes from the suite source", () => {
    expect(summarize({ suite: { source: "/x/evals/plan-easy" } }).benchmark).toBe("plan-easy");
  });

  it("the run row's benchmark wins over the suite source", () => {
    const summary = summarize({
      suite: { source: "/x/evals/plan-easy" },
      benchmark: "swe-bench-verified",
    });
    expect(summary.benchmark).toBe("swe-bench-verified");
  });

  it("the run row's reasoning fills calls with no level", () => {
    const summary = summarize({ reasoning: "medium" });
    expect(summary.models.map((item) => [item.name, item.reasoning])).toEqual([
      ["jev", "medium"],
      ["opus", "high"],
    ]);
  });

  it("an --input run has no benchmark", () => {
    expect(summarize({ suite: { source: "inline:--input" } }).benchmark).toBeNull();
  });
});
