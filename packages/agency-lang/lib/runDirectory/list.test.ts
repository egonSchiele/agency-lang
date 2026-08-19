import { describe, expect, it } from "vitest";

import { completeAnnotation } from "./annotations.js";

import { summarizeRuns } from "./list.js";
import { recordGradingPass, recordNote } from "./mutations.js";
import { readRunDirectory } from "./runDir.js";
import { agentStartLine, statelogLine, tempDir } from "./testFixtures.js";
import * as fs from "fs";
import * as path from "path";

const quiet = { reportWarning: () => {} };

function writeStatelog(dir: string, ...lines: string[]): void {
  fs.writeFileSync(path.join(dir, "statelog.jsonl"), lines.join("\n") + "\n");
}

describe("summarizeRuns", () => {
  it("summarizes a finished trace with a note and a score", () => {
    const dir = tempDir();
    writeStatelog(
      dir,
      statelogLine("t1", "agentStart", { entryNode: "main", args: {}, input: "summarize x" }),
      statelogLine("t1", "agentEnd", { result: "done", timeTaken: 5 }),
      statelogLine("t2", "agentStart", { entryNode: "main", args: {} }),
    );
    recordNote({ dir, traceId: "t1", annotator: { kind: "human", id: "adit" }, text: "fine" });
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
      noteCount: 1,
      labeled: false,
      codeHash: null,
    });
    expect(second).toMatchObject({
      traceId: "t2",
      input: null,
      ended: "unknown",
      latestScore: null,
      noteCount: 0,
    });
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
