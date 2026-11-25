import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { completeAnnotation, type Annotation, type AnnotationDraft } from "./annotations.js";
import { summarizeEvalRun } from "./list.js";
import { readRunDirectory } from "./runDir.js";
import { agentStartLine, statelogLine } from "./testFixtures.js";
import { digestTrace, TraceDigestSchema, type TraceDigest } from "./traceDigest.js";

const quiet = { reportWarning: () => {} };

/** What statelog does with a digest: JSON in, schema-checked, JSON out. */
function stored(digest: TraceDigest): TraceDigest {
  return TraceDigestSchema.parse(JSON.parse(JSON.stringify(digest)));
}

function expectSameSummaryBothWays({
  traceId,
  events,
  annotations,
}: {
  traceId: string;
  events: readonly EventEnvelope[];
  annotations: readonly Annotation[];
}): void {
  const fromEvents = summarizeEvalRun({ traceId, events, annotations, source: "events" });
  const digest = stored(digestTrace({ events, source: "digest" }));
  const fromDigest = summarizeEvalRun({ traceId, digest, annotations, source: "digest" });
  expect(fromDigest).toEqual(fromEvents);
}

function fromDirectory(dir: string): {
  traceId: string;
  events: readonly EventEnvelope[];
  annotations: readonly Annotation[];
} {
  const snapshot = readRunDirectory(dir, quiet);
  const traceId = snapshot.traces[0]?.traceId ?? snapshot.annotationRows[0].traceId;
  return {
    traceId,
    events: snapshot.traces[0]?.events ?? [],
    annotations: snapshot.annotationRows,
  };
}

function events(...lines: string[]): EventEnvelope[] {
  return lines.map((line) => JSON.parse(line) as EventEnvelope);
}

function runRow(traceId: string, fields: Partial<AnnotationDraft> = {}): Annotation {
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

function completion(traceId: string, model: string, reasoningEffort: string | null): string {
  return statelogLine(traceId, "promptCompletion", {
    model: JSON.stringify(model),
    reasoningEffort,
    usage: { inputTokens: 10, cachedInputTokens: 20, cacheCreationInputTokens: 1, outputTokens: 3 },
    cost: { totalCost: 0.1 },
  });
}

describe("a summary from the digest equals the summary from the events", () => {
  it("a finished suite run", () => {
    const dir = writeRunDirectory({
      test: { id: "a", input: "t" },
      output: "x",
      costUsd: 0.5,
      batch: "batch-1",
      trial: 2,
    });
    expectSameSummaryBothWays(fromDirectory(dir));
  });

  it("a run that ended in an error", () => {
    const dir = writeRunDirectory({
      test: { id: "a", input: "t" },
      ended: "error",
      errorMessage: "boom",
    });
    expectSameSummaryBothWays(fromDirectory(dir));
  });

  it("a run that never wrote a trace", () => {
    const dir = writeRunDirectory({
      traceId: "silent-1",
      test: { id: "a", input: "t" },
      wroteStatelog: false,
      ended: "error",
    });
    expectSameSummaryBothWays(fromDirectory(dir));
  });

  it("a trace with no run row takes its ending from the trace", () => {
    const traceId = "adhoc-1";
    expectSameSummaryBothWays({
      traceId,
      events: events(agentStartLine(traceId), completion(traceId, "opus", "high")),
      annotations: [],
    });
  });

  it("the run row's reasoning fills calls that recorded none, merging with matching ones", () => {
    const traceId = "usage-1";
    expectSameSummaryBothWays({
      traceId,
      events: events(
        agentStartLine(traceId),
        completion(traceId, "opus", "high"),
        completion(traceId, "opus", null),
        completion(traceId, "jev", null),
      ),
      annotations: [runRow(traceId, { reasoning: "high" })],
    });
  });

  it("the code hash comes from agentStart", () => {
    const traceId = "code-1";
    const start = agentStartLine(traceId, {
      entry: "main.agency",
      closureHash: "abc123",
      closure: [],
    });
    const digest = digestTrace({ events: events(start), source: "x" });
    expect(digest.codeHash).toBe("abc123");
    expectSameSummaryBothWays({ traceId, events: events(start), annotations: [runRow(traceId)] });
  });
});

describe("TraceDigestSchema", () => {
  const digest = digestTrace({ events: events(agentStartLine("t")), source: "x" });

  it("accepts what digestTrace produces", () => {
    expect(TraceDigestSchema.safeParse(digest).success).toBe(true);
  });

  it("rejects an unknown key, so an older reader never drops a field it doesn't know", () => {
    expect(TraceDigestSchema.safeParse({ ...digest, newField: 1 }).success).toBe(false);
  });

  it("rejects a missing field and an unknown ending", () => {
    const { eventCount: _dropped, ...missing } = digest;
    expect(TraceDigestSchema.safeParse(missing).success).toBe(false);
    expect(TraceDigestSchema.safeParse({ ...digest, traceEnding: "maybe" }).success).toBe(false);
  });
});

// Stored digests can't be recomputed, so every past version must keep
// reading. Never edit this fixture; add one beside it for a new version.
describe("a frozen version-1 digest", () => {
  const fixture: unknown = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "fixtures", "traceDigest-v1.json"), "utf8"),
  );

  it("still parses", () => {
    expect(TraceDigestSchema.safeParse(fixture).success).toBe(true);
  });

  it("still summarizes, with the run row's reasoning filling the unleveled model", () => {
    const traceId = "frozen-1";
    const summary = summarizeEvalRun({
      traceId,
      digest: TraceDigestSchema.parse(fixture),
      annotations: [runRow(traceId, { reasoning: "low" })],
      source: "fixture",
    });
    expect(summary).toMatchObject({
      eventCount: 42,
      durationMs: 90000,
      llmCalls: 3,
      toolCalls: 5,
      costUsd: 0.875,
      inputTokens: 160,
      status: "ok",
      // The digest's last event, not the run row's time.
      endedAt: "2026-08-23T00:01:30.000Z",
      codeHash: "abc123",
    });
    expect(summary.models.map((item) => [item.name, item.reasoning])).toEqual([
      ["jev", "low"],
      ["opus", "high"],
    ]);
  });
});
