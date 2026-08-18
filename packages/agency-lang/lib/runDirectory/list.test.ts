import { describe, expect, it } from "vitest";

import { completeAnnotation } from "./annotations.js";

import { summarizeRuns } from "./list.js";
import { addToRunDirectory, recordGradingPass, recordNote } from "./mutations.js";
import { readRunDirectory } from "./runDir.js";
import { agentStartLine, statelogLine, tempDir } from "./testFixtures.js";
import * as fs from "fs";
import * as path from "path";

const quiet = { reportWarning: () => {} };

function statelogFile(...lines: string[]): string {
  const file = path.join(tempDir("log-"), "statelog.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("summarizeRuns", () => {
  it("summarizes a finished trace with a note and a score", () => {
    const dir = tempDir();
    addToRunDirectory({
      dir,
      statelogFiles: [
        statelogFile(
          statelogLine("t1", "agentStart", { entryNode: "main", args: {}, input: "summarize x" }),
          statelogLine("t1", "agentEnd", { result: "done", timeTaken: 5 }),
          statelogLine("t2", "agentStart", { entryNode: "main", args: {} }),
        ),
      ],
      codeEntries: [],
      annotationFiles: [],
    });
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

  it("prefers the harness verdict over the trace's own ending", () => {
    const dir = tempDir();
    addToRunDirectory({
      dir,
      statelogFiles: [statelogFile(agentStartLine("t1"))],
      codeEntries: [],
      annotationFiles: [],
    });
    // A run row written directly through the annotation import path.
    const rowFile = path.join(tempDir("ann-"), "annotations.jsonl");
    fs.writeFileSync(
      rowFile,
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
    addToRunDirectory({ dir, statelogFiles: [], codeEntries: [], annotationFiles: [rowFile] });
    expect(summarizeRuns(readRunDirectory(dir, quiet))[0].ended).toBe("timeout");
  });
});
