import { describe, it, expect } from "vitest";
import { buildForest } from "./tree.js";
import { EventEnvelope } from "./types.js";

const evt = (over: Partial<EventEnvelope>): EventEnvelope => ({
  format_version: 1,
  trace_id: "t1",
  project_id: "p",
  span_id: null,
  parent_span_id: null,
  data: { type: "debug", timestamp: "2026-05-16T00:00:00Z" },
  ...over,
});

describe("buildForest", () => {
  it("returns one root per trace_id", () => {
    const forest = buildForest([
      evt({ trace_id: "a" }),
      evt({ trace_id: "b" }),
      evt({ trace_id: "a" }),
    ]);
    expect(forest).toHaveLength(2);
    expect(forest.map((r) => r.traceId).sort()).toEqual(["a", "b"]);
  });

  it("nests span children under their parent span", () => {
    const forest = buildForest([
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: { type: "agentStart", timestamp: "" },
      }),
      evt({
        span_id: "s2",
        parent_span_id: "s1",
        data: { type: "enterNode", timestamp: "", nodeId: "main" },
      }),
      evt({
        span_id: "s2",
        parent_span_id: "s1",
        data: { type: "promptCompletion", timestamp: "" },
      }),
    ]);
    const trace = forest[0];
    const s1 = trace.children[0];
    expect(s1.nodeKind).toBe("span");
    const s2 = s1.children[0];
    expect(s2.nodeKind).toBe("span");
    expect(s2.children).toHaveLength(2);
  });

  it("attaches events with no span_id directly under the trace root", () => {
    const forest = buildForest([
      evt({ data: { type: "debug", timestamp: "", message: "rootless" } }),
    ]);
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].nodeKind).toBe("event");
  });

  it("aggregates tokens and cost from promptCompletion children", () => {
    const forest = buildForest([
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: {
          type: "promptCompletion",
          timestamp: "",
          usage: { inputTokens: 100, outputTokens: 200 },
          cost: { totalCost: 0.0042 },
        },
      }),
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: {
          type: "promptCompletion",
          timestamp: "",
          usage: { inputTokens: 50, outputTokens: 50 },
          cost: { totalCost: 0.001 },
        },
      }),
    ]);
    const s1 = forest[0].children[0];
    expect(s1.tokens).toBe(400);
    expect(s1.cost).toBeCloseTo(0.0052, 5);
  });

  it("prefers promptCompletion.timeTaken for llmCall span duration", () => {
    // Both events fire at nearly the same moment (the timestamps
    // are *emission* times), but the LLM call actually took 3.5s
    // as recorded in promptCompletion.timeTaken. Without the fix the
    // viewer would show 1ms.
    const forest = buildForest([
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: {
          type: "promptCompletion",
          timestamp: "2026-05-16T00:00:03.500Z",
          timeTaken: 3500,
        },
      }),
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: {
          type: "debug",
          timestamp: "2026-05-16T00:00:03.501Z",
          message: "ack",
        },
      }),
    ]);
    const s1 = forest[0].children[0];
    expect(s1.label).toBe("llmCall");
    expect(s1.duration).toBe(3500);
  });

  it("sums timeTaken across multiple toolCall leaves for toolExecution spans", () => {
    const forest = buildForest([
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: { type: "toolCall", timestamp: "", timeTaken: 120 },
      }),
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: { type: "toolCall", timestamp: "", timeTaken: 80 },
      }),
    ]);
    const s1 = forest[0].children[0];
    expect(s1.label).toBe("toolExecution");
    expect(s1.duration).toBe(200);
  });

  it("falls back to timestamp range when no characteristic event has timeTaken", () => {
    const forest = buildForest([
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: { type: "debug", timestamp: "2026-05-16T00:00:00.000Z" },
      }),
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: { type: "debug", timestamp: "2026-05-16T00:00:02.000Z" },
      }),
    ]);
    const s1 = forest[0].children[0];
    expect(s1.duration).toBeCloseTo(2000, 0);
  });

  it("computes duration from first to last event timestamp", () => {
    const forest = buildForest([
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: {
          type: "agentStart",
          timestamp: "2026-05-16T00:00:00.000Z",
        },
      }),
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: {
          type: "agentEnd",
          timestamp: "2026-05-16T00:00:04.200Z",
        },
      }),
    ]);
    const s1 = forest[0].children[0];
    expect(s1.duration).toBeCloseTo(4200, 0);
  });

  it("preserves event arrival order within a span", () => {
    const forest = buildForest([
      evt({
        span_id: "s1",
        data: { type: "debug", timestamp: "", message: "first" },
      }),
      evt({
        span_id: "s1",
        data: { type: "debug", timestamp: "", message: "second" },
      }),
    ]);
    const events = forest[0].children[0].children;
    expect(events[0].event!.data.message).toBe("first");
    expect(events[1].event!.data.message).toBe("second");
  });

  it("sorts children chronologically by timestamp (events and spans interleaved)", () => {
    // Under agentRun span s1, the chronology is:
    //   t=0   agentStart leaf
    //   t=1s  nodeExecution span s2 (introduced by enterNode)
    //   t=3s  agentEnd leaf
    // The previous implementation always listed s2 before its leaf
    // siblings; chronological order should put agentStart, then s2,
    // then agentEnd.
    const forest = buildForest([
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: {
          type: "agentStart",
          timestamp: "2026-05-16T00:00:00.000Z",
        },
      }),
      evt({
        span_id: "s2",
        parent_span_id: "s1",
        data: {
          type: "enterNode",
          timestamp: "2026-05-16T00:00:01.000Z",
          nodeId: "main",
        },
      }),
      evt({
        span_id: "s2",
        parent_span_id: "s1",
        data: {
          type: "exitNode",
          timestamp: "2026-05-16T00:00:02.000Z",
        },
      }),
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: {
          type: "agentEnd",
          timestamp: "2026-05-16T00:00:03.000Z",
        },
      }),
    ]);
    const s1 = forest[0].children[0];
    const kinds = s1.children.map((c) => `${c.nodeKind}:${c.label}`);
    expect(kinds).toEqual([
      "event:agentStart",
      "span:nodeExecution",
      "event:agentEnd",
    ]);
  });

  it("re-parents a child span when its parent appears later in the stream", () => {
    // Child span s2 is observed BEFORE its parent s1 has emitted any
    // event. The tree should still nest s2 under s1, not under the
    // trace root, once both spans exist.
    const forest = buildForest([
      evt({
        span_id: "s2",
        parent_span_id: "s1",
        data: { type: "debug", timestamp: "", message: "early child" },
      }),
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: { type: "agentStart", timestamp: "" },
      }),
    ]);
    const trace = forest[0];
    expect(trace.children).toHaveLength(1);
    const s1 = trace.children[0];
    expect(s1.id).toBe("s1");
    expect(s1.children[0].id).toBe("s2");
    expect(s1.children[0].parentId).toBe("s1");
  });

  it("orphaned parent_span_id attaches to the trace root", () => {
    const forest = buildForest([
      evt({
        span_id: "s2",
        parent_span_id: "s1-never-seen",
        data: { type: "debug", timestamp: "" },
      }),
    ]);
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].id).toBe("s2");
    expect(forest[0].children[0].parentId).toBe(forest[0].id);
  });
});
