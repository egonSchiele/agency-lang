import { describe, expect, it } from "vitest";

import { completeAnnotation } from "./annotations.js";

import { annotationSummaryText, buildRunsListing, displayAgent, summarizeRuns } from "./list.js";
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
      statelogLine("t2", "agentStart", { entryNode: "main", args: {} }),
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
    const [first, second] = summarizeRuns(readRunDirectory(dir, quiet));
    expect(first).toMatchObject({
      traceId: "t1",
      input: "summarize x",
      ended: "ok",
      latestScore: 0.75,
      hasNotes: true,
      labeled: false,
      codeHash: null,
    });
    expect(second).toMatchObject({
      traceId: "t2",
      input: null,
      ended: "unknown",
      latestScore: null,
      hasNotes: true,
    });
    expect(annotationSummaryText(first)).toBe("notes · score 0.75");
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
    const twoTraces = tempDir();
    writeStatelog(twoTraces, agentStartLine("t1"), agentStartLine("t2"));
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
    const silent = tempDir();
    writeStatelog(silent);
    fs.writeFileSync(path.join(silent, "statelog.jsonl"), "");

    const listing = buildRunsListing(
      [twoTraces, graded, silent].map((dir) => readRunDirectory(dir, quiet)),
    );
    expect(listing.summaries.map((summary) => summary.traceId)).toEqual(["t1", "t2", "t3"]);
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
    const dir = tempDir();
    writeStatelog(
      dir,
      agentStartLine("named"),
      statelogLine("named", "agentName", { name: "greeter" }),
      agentStartLine("file"),
      agentStartLine("command"),
      agentStartLine("bare"),
    );
    const command = "/usr/bin/python /tmp/agent.py --workdir /tmp/data";
    fs.writeFileSync(
      path.join(dir, "annotations.jsonl"),
      runRow("named", { agent: "/abs/agents/other.agency:main" }) +
        runRow("file", { agent: "/abs/agents/greeter.agency:main" }) +
        runRow("command", { agent: command }),
    );
    const byTrace = Object.fromEntries(
      summarizeRuns(readRunDirectory(dir, quiet)).map((summary) => [
        summary.traceId,
        displayAgent(summary),
      ]),
    );
    expect(byTrace).toEqual({
      named: "greeter",
      file: "/abs/agents/greeter.agency:main",
      command,
      bare: null,
    });
  });
});
