import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import type {
  EvalUploadClient,
  RemoteTraceState,
  SequencedEvent,
} from "@/cli/statelog/evalUploadClient.js";
import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import type { Annotation } from "@/runDirectory/annotations.js";
import { recordGradingPass } from "@/runDirectory/mutations.js";
import { statelogLine, tempDir } from "@/runDirectory/testFixtures.js";

import { eventPlan, evalUpload, formatUploadResult } from "./upload.js";

const target = { origin: "https://h", projectSlug: "proj", apiKey: "k" };

type Posted = { traceId: string; events: SequencedEvent[] };

/** A client that answers upload-state from a table and records every post. */
function fakeClient(
  states: Record<string, RemoteTraceState>,
  options: { failAnnotationsFor?: string } = {},
) {
  const posted: Posted[] = [];
  const annotations: Annotation[][] = [];
  const client: EvalUploadClient = {
    async traceUploadState(traceId) {
      return states[traceId] ?? { kind: "missing" };
    },
    async postEvents(traceId, events) {
      posted.push({ traceId, events: [...events] });
    },
    async postAnnotations(rows) {
      if (rows.some((row) => row.traceId === options.failAnnotationsFor)) {
        throw new Error("annotations rejected");
      }
      annotations.push([...rows]);
    },
  };
  return { client, posted, annotations };
}

/** A run directory whose trace has `count` events and names its agent. */
function bigRun(count: number, agentName: string = "agency-agent/simple"): string {
  const dir = tempDir("upload-");
  const lines = [
    statelogLine("big", "agentStart", { entryNode: "main", args: {} }),
    statelogLine("big", "agentName", { name: agentName }),
  ];
  while (lines.length < count) {
    lines.push(statelogLine("big", "tick", { n: lines.length }));
  }
  fs.writeFileSync(path.join(dir, "statelog.jsonl"), lines.join("\n") + "\n");
  return dir;
}

describe("eventPlan", () => {
  it("decides every server state against the file's event count", () => {
    expect(eventPlan({ kind: "missing" }, 0)).toEqual({ kind: "create-empty" });
    expect(eventPlan({ kind: "missing" }, 3)).toEqual({ kind: "upload-all" });
    expect(eventPlan({ kind: "empty" }, 0)).toEqual({ kind: "skip", serverEvents: 0 });
    expect(eventPlan({ kind: "empty" }, 3)).toEqual({ kind: "upload-all" });
    expect(eventPlan({ kind: "live", eventCount: 3 }, 3)).toEqual({ kind: "skip", serverEvents: 3 });
    expect(eventPlan({ kind: "live", eventCount: 2 }, 3)).toMatchObject({ kind: "refuse" });
    expect(eventPlan({ kind: "live", eventCount: 4 }, 3)).toMatchObject({ kind: "refuse" });
    expect(eventPlan({ kind: "bulk-prefix", eventCount: 3, nextSequence: 3 }, 3)).toEqual({
      kind: "skip",
      serverEvents: 3,
    });
    expect(eventPlan({ kind: "bulk-prefix", eventCount: 2, nextSequence: 2 }, 3)).toEqual({
      kind: "resume",
      from: 2,
    });
    expect(eventPlan({ kind: "bulk-prefix", eventCount: 4, nextSequence: 4 }, 3)).toMatchObject({
      kind: "refuse",
    });
    const invalid = eventPlan({ kind: "invalid", eventCount: 2, reason: "gap after 0" }, 3);
    expect(invalid).toEqual({
      kind: "refuse",
      reason: "the server reports an unusable trace: gap after 0",
    });
  });
});

describe("evalUpload", () => {
  it("uploads a new trace in 500-event chunks with sequences 0..n-1, then its annotations", async () => {
    const dir = bigRun(603);
    const { client, posted, annotations } = fakeClient({});
    const result = await evalUpload([dir], target, { client });
    expect(result.runs).toEqual([
      { dir: fs.realpathSync(dir), traceId: "big", status: "uploaded", events: 603, annotations: 0 },
    ]);
    expect(posted.map((post) => post.events.length)).toEqual([500, 103]);
    const sequences = posted.flatMap((post) => post.events.map((event) => event.sequence));
    expect(sequences).toEqual(Array.from({ length: 603 }, (_, index) => index));
    expect(posted[1].events[0].envelope.data.n).toBe(500);
    // No annotation rows, so no annotation request.
    expect(annotations).toEqual([]);
  });

  it("resumes a proven bulk prefix at its next sequence", async () => {
    const dir = bigRun(10);
    const { client, posted } = fakeClient({
      big: { kind: "bulk-prefix", eventCount: 7, nextSequence: 7 },
    });
    const result = await evalUpload([dir], target, { client });
    expect(result.runs[0]).toMatchObject({ status: "resumed", from: 7, events: 3 });
    expect(posted[0].events.map((event) => event.sequence)).toEqual([7, 8, 9]);
  });

  it("a run that never wrote a trace creates an empty trace, then posts its run and score rows", async () => {
    const dir = writeRunDirectory({
      traceId: "silent",
      test: { id: "a", input: "t" },
      wroteStatelog: false,
      ended: "error",
      batch: "b1",
      trial: 1,
    });
    const { client, posted, annotations } = fakeClient({});
    const result = await evalUpload([dir], target, { client });
    expect(result.runs[0]).toMatchObject({
      traceId: "silent",
      status: "uploaded",
      events: 0,
      annotations: 1,
    });
    expect(posted).toEqual([{ traceId: "silent", events: [] }]);
    expect(annotations[0].map((row) => row.kind)).toEqual(["run"]);
  });

  it("refuses a partial live trace and an invalid one, posting neither events nor annotations", async () => {
    const live = writeRunDirectory({ traceId: "live", test: { id: "a", input: "t" }, output: "x" });
    const broken = writeRunDirectory({
      traceId: "broken",
      test: { id: "b", input: "t" },
      output: "x",
    });
    const { client, posted, annotations } = fakeClient({
      live: { kind: "live", eventCount: 1 },
      broken: { kind: "invalid", eventCount: 2, reason: "sequence 1 appears twice" },
    });
    const result = await evalUpload([live, broken], target, { client });
    expect(result.runs.map((run) => run.status)).toEqual(["failed", "failed"]);
    expect(result.runs.map((run) => (run.status === "failed" ? run.error : ""))).toEqual([
      expect.stringMatching(/live-streamed events/),
      expect.stringMatching(/sequence 1 appears twice/),
    ]);
    expect(posted).toEqual([]);
    expect(annotations).toEqual([]);
    expect(result.batchUrl).toBeNull();
  });

  it("a failed annotation post fails that run only; the next directory still uploads", async () => {
    const group = tempDir("group-");
    writeRunDirectory(
      { traceId: "first", test: { id: "a", input: "t" }, output: "x" },
      path.join(group, "a"),
    );
    writeRunDirectory(
      { traceId: "second", test: { id: "b", input: "t" }, output: "x" },
      path.join(group, "b"),
    );
    const { client, posted } = fakeClient({}, { failAnnotationsFor: "first" });
    const result = await evalUpload([group], target, { client });
    expect(result.runs.map((run) => [run.traceId, run.status])).toEqual([
      ["first", "failed"],
      ["second", "uploaded"],
    ]);
    expect(posted.map((post) => post.traceId)).toEqual(["first", "second"]);
  });

  it("a second upload skips the events the server has and still upserts the annotations", async () => {
    const dir = writeRunDirectory({ traceId: "done", test: { id: "a", input: "t" }, output: "x" });
    recordGradingPass({
      dir,
      scores: [
        {
          traceId: "done",
          annotator: { kind: "grader", id: "g@1" },
          name: "a",
          score: { kind: "binary", pass: true },
          weight: 1,
          mustPass: false,
        },
      ],
    });
    const { client, posted, annotations } = fakeClient({
      done: { kind: "bulk-prefix", eventCount: 3, nextSequence: 3 },
    });
    const result = await evalUpload([dir], target, { client });
    expect(result.runs[0]).toMatchObject({
      status: "present",
      serverEvents: 3,
      fileEvents: 3,
      annotations: 2,
    });
    expect(posted).toEqual([]);
    expect(annotations[0].map((row) => row.kind).sort()).toEqual(["run", "score"]);
  });

  it("names the batch page only when every uploaded run shares one batch and one valid agent name", async () => {
    const group = tempDir("group-");
    for (const [testId, traceId] of [
      ["a", "ta"],
      ["b", "tb"],
    ]) {
      const dir = path.join(group, testId);
      writeRunDirectory({ traceId, test: { id: testId, input: "t" }, batch: "b 1", trial: 1 }, dir);
      fs.appendFileSync(
        path.join(dir, "statelog.jsonl"),
        statelogLine(traceId, "agentName", { name: "agency-agent/coordinator" }) + "\n",
      );
    }
    const shared = await evalUpload([group], target, { client: fakeClient({}).client });
    expect(shared.batchUrl).toBe(
      "https://h/projects/proj/evals/agents/agency-agent%2Fcoordinator/batches/b%201",
    );

    // Different batches: no page shows exactly these runs.
    const other = writeRunDirectory({
      traceId: "tc",
      test: { id: "c", input: "t" },
      batch: "b2",
      trial: 1,
    });
    const mixed = await evalUpload([group, other], target, { client: fakeClient({}).client });
    expect(mixed.batchUrl).toBeNull();
  });

  it("an agent name that would not survive a URL gets no batch page", async () => {
    const dir = writeRunDirectory({
      traceId: "dots",
      test: { id: "a", input: "t" },
      batch: "b1",
      trial: 1,
    });
    fs.appendFileSync(
      path.join(dir, "statelog.jsonl"),
      statelogLine("dots", "agentName", { name: ".." }) + "\n",
    );
    const result = await evalUpload([dir], target, { client: fakeClient({}).client });
    expect(result.runs[0].status).toBe("uploaded");
    expect(result.batchUrl).toBeNull();
  });
});

describe("formatUploadResult", () => {
  it("one line per run, the counts, and the batch page", () => {
    const lines = formatUploadResult(
      {
        runs: [
          { dir: "/runs/b1/a", traceId: "ta", status: "uploaded", events: 12, annotations: 2 },
          {
            dir: "/runs/b1/b",
            traceId: "tb",
            status: "present",
            serverEvents: 9,
            fileEvents: 9,
            annotations: 2,
          },
          { dir: "/runs/b1/c", traceId: "tc", status: "resumed", from: 500, events: 3, annotations: 1 },
          { dir: "/runs/b1/d", traceId: null, status: "failed", error: "could not reach h" },
        ],
        batchUrl: "https://h/projects/p/evals/agents/x/batches/b1",
      },
      "/elsewhere",
    );
    expect(lines).toEqual([
      "/runs/b1/a: uploaded 12 events, 2 annotations",
      "/runs/b1/b: already present (9 events); 2 annotations upserted",
      "/runs/b1/c: resumed at event 500: 3 events, 1 annotations",
      "/runs/b1/d: failed: could not reach h",
      "1 uploaded · 1 present · 1 resumed · 1 failed",
      "batch: https://h/projects/p/evals/agents/x/batches/b1",
    ]);
  });
});
