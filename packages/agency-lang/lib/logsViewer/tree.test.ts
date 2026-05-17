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
