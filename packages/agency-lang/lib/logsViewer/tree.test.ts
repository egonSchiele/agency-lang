import { describe, it, expect } from "vitest";
import { buildForest } from "./tree.js";
import { EventEnvelope, TreeNode } from "./types.js";

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
  it("hides graph schema events from the tree", () => {
    const forest = buildForest([
      evt({ data: { type: "agentStart", timestamp: "" } }),
      evt({ data: { type: "graph", timestamp: "", nodes: ["main"], edges: {}, startNode: "main" } }),
      evt({ data: { type: "enterNode", timestamp: "", nodeId: "main" } }),
    ]);
    const labels = forest[0].children.map((c) => c.label);
    expect(labels).not.toContain("graph");
    expect(labels).toContain("agentStart");
    expect(labels).toContain("enterNode");
  });

  it("returns one root per trace_id", () => {
    const forest = buildForest([
      evt({ trace_id: "a" }),
      evt({ trace_id: "b" }),
      evt({ trace_id: "a" }),
    ]);
    expect(forest).toHaveLength(2);
    expect(forest.map((r) => r.traceId).sort()).toEqual(["a", "b"]);
  });

  it("upgrades a weak span label when a definitive event arrives later", () => {
    // The subprocessRun span's first event is runBatch's branch
    // threadCreated; subprocessStarted lands second. The span label must
    // upgrade from the passthrough "threadCreated" to "subprocessRun".
    const forest = buildForest([
      evt({ span_id: "s1", data: { type: "threadCreated", timestamp: "", threadId: "1", threadType: "subthread" } }),
      evt({ span_id: "s1", data: { type: "subprocessStarted", timestamp: "", moduleId: "m", node: "main", subprocessSessionId: "x", mode: "run", depth: 1 } }),
    ]);
    const span = forest[0].children[0];
    expect(span.nodeKind).toBe("span");
    expect(span.label).toBe("subprocessRun");
  });

  it("does not downgrade a strong span label", () => {
    const forest = buildForest([
      evt({ span_id: "s1", data: { type: "agentStart", timestamp: "", entryNode: "main" } }),
      evt({ span_id: "s1", data: { type: "threadCreated", timestamp: "", threadId: "1", threadType: "thread" } }),
    ]);
    expect(forest[0].children[0].label).toBe("agentRun");
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

  it("uses promptCompletion.timeTaken for a single-round llmCall duration", () => {
    // The emission timestamp is the END of the call, so the timestamp
    // range alone would be ~0ms. The envelope (start = timestamp -
    // timeTaken) recovers the real 3.5s latency.
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
    ]);
    const s1 = forest[0].children[0];
    expect(s1.label).toBe("llmCall");
    expect(s1.duration).toBe(3500);
  });

  it("computes wall-clock across back-to-back toolCall leaves (not a blind sum)", () => {
    // Two sequential toolCalls (e.g. a retry): 120ms then 80ms,
    // back-to-back, so the wall-clock envelope is 200ms.
    const forest = buildForest([
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: { type: "toolCall", timestamp: "2026-05-16T00:00:00.120Z", timeTaken: 120 },
      }),
      evt({
        span_id: "s1",
        parent_span_id: null,
        data: { type: "toolCall", timestamp: "2026-05-16T00:00:00.200Z", timeTaken: 80 },
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

  it("uses wall-clock, NOT the sum of nested parallel llmCall durations", () => {
    // An outer llmCall (L) runs a tool (T) whose body forks two parallel
    // llmCalls (N1, N2), each ~3s, overlapping. The OLD logic summed
    // every promptCompletion.timeTaken in the subtree
    // (1 + 3 + 3 + 1 = 8s), making the parent appear longer than it ran
    // and longer than its own node. The wall-clock envelope is 5s, and
    // parent ⊇ child holds.
    const B = "2026-06-21T00:00:0";
    const forest = buildForest([
      evt({ span_id: "A", parent_span_id: null, data: { type: "agentStart", timestamp: `${B}0.000Z` } }),
      evt({ span_id: "L", parent_span_id: "A", data: { type: "promptCompletion", timestamp: `${B}1.000Z`, timeTaken: 1000 } }),
      evt({ span_id: "T", parent_span_id: "L", data: { type: "toolCall", timestamp: `${B}4.000Z`, timeTaken: 3000, toolName: "fib" } }),
      evt({ span_id: "N1", parent_span_id: "T", data: { type: "promptCompletion", timestamp: `${B}4.000Z`, timeTaken: 3000 } }),
      evt({ span_id: "N2", parent_span_id: "T", data: { type: "promptCompletion", timestamp: `${B}4.000Z`, timeTaken: 3000 } }),
      evt({ span_id: "L", parent_span_id: "A", data: { type: "promptCompletion", timestamp: `${B}5.000Z`, timeTaken: 1000 } }),
      evt({ span_id: "A", parent_span_id: null, data: { type: "agentEnd", timestamp: `${B}5.500Z`, timeTaken: 5500 } }),
    ]);
    const find = (id: string): TreeNode => {
      const stack = [...forest];
      while (stack.length) {
        const n = stack.pop()!;
        if (n.id === id) return n;
        stack.push(...n.children);
      }
      throw new Error(`span ${id} not found`);
    };
    const L = find("L");
    const T = find("T");
    const N1 = find("N1");
    expect(L.label).toBe("llmCall");
    expect(L.duration).toBe(5000); // wall-clock, not 8000 (the old sum)
    expect(T.duration).toBe(3000);
    expect(N1.duration).toBe(3000);
    // Parent contains child: no child is longer than its parent.
    expect(T.duration!).toBeLessThanOrEqual(L.duration!);
    expect(N1.duration!).toBeLessThanOrEqual(T.duration!);
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

describe("promptStart pairing", () => {
  const start = (span: string) =>
    evt({
      span_id: span,
      data: {
        type: "promptStart",
        timestamp: "",
        model: '"m"',
        threadId: "1",
        messageCount: 2,
        toolCount: 0,
        hasResponseFormat: true,
        maxTokens: 2000,
      },
    });
  const completion = (span: string) =>
    evt({
      span_id: span,
      data: { type: "promptCompletion", timestamp: "", model: '"m"', timeTaken: 5 },
    });
  const llmError = (span: string) =>
    evt({
      span_id: span,
      data: { type: "error", timestamp: "", errorType: "llmError", message: "boom" },
    });
  const cancelled = (span: string) =>
    evt({
      span_id: span,
      data: { type: "promptCancelled", timestamp: "", threadId: "1" },
    });

  it("hides a paired promptStart leaf, keeps the completion", () => {
    const forest = buildForest([start("s1"), completion("s1")]);
    const span = forest[0].children[0];
    expect(span.children.map((c) => c.label)).toEqual(["promptCompletion"]);
  });

  it("renders an unpaired promptStart, labeling its span llmCall", () => {
    const forest = buildForest([start("s1")]);
    const span = forest[0].children[0];
    expect(span.children.map((c) => c.label)).toEqual(["promptStart"]);
    expect(span.label).toBe("llmCall");
  });

  it("pairs nth start with nth terminator per span (multi-round)", () => {
    const forest = buildForest([start("s1"), completion("s1"), start("s1")]);
    const span = forest[0].children[0];
    expect(span.children.map((c) => c.label)).toEqual([
      "promptCompletion",
      "promptStart",
    ]);
  });

  it("an llmError terminates (pairs) a start", () => {
    const forest = buildForest([start("s1"), llmError("s1")]);
    const span = forest[0].children[0];
    expect(span.children.map((c) => c.label)).toEqual(["error"]);
  });

  it("a promptCancelled terminates (pairs) a start — healthy race losers stay quiet", () => {
    const forest = buildForest([start("s1"), cancelled("s1")]);
    const span = forest[0].children[0];
    expect(span.children.map((c) => c.label)).toEqual(["promptCancelled"]);
  });

  it("pairing is per-span: a completion in another span pairs nothing", () => {
    const forest = buildForest([start("s1"), completion("s2")]);
    const spans = forest[0].children;
    const allLeafLabels = spans.flatMap((s) => s.children.map((c) => c.label));
    expect(allLeafLabels).toContain("promptStart");
  });

  it("the post-resume shape: abandoned start alone in span A, paired start in span B", () => {
    // On resume the llmCall span is re-opened with a NEW span id
    // (deliberately outside pr.step), so a killed-mid-call run leaves:
    // span A = one abandoned unpaired start; span B = start +
    // completion. The abandoned one must render; the resumed one must
    // hide.
    const forest = buildForest([start("sA"), start("sB"), completion("sB")]);
    const spans = forest[0].children;
    const leavesBySpan = spans.map((s) => s.children.map((c) => c.label));
    expect(leavesBySpan).toContainEqual(["promptStart"]);
    expect(leavesBySpan).toContainEqual(["promptCompletion"]);
  });

  it("tolerates prototype-chain span ids in a crafted log (no crash, still pairs)", () => {
    // Untrusted-input guard: with a plain-object accumulator, span_id
    // "constructor"/"__proto__" resolved through the prototype chain and
    // .push threw, crashing the viewer on a crafted or corrupt log.
    const forest = buildForest([
      start("constructor"),
      completion("constructor"),
      start("__proto__"),
    ]);
    const spans = forest[0].children;
    const leavesBySpan = spans.map((s) => s.children.map((c) => c.label));
    expect(leavesBySpan).toContainEqual(["promptCompletion"]);
    expect(leavesBySpan).toContainEqual(["promptStart"]);
  });

  it("labels the threadEndHooks span from its start event", () => {
    const forest = buildForest([
      evt({
        span_id: "h1",
        data: {
          type: "threadEndHooksStart",
          timestamp: "",
          threadId: "t1",
          eagerSummarize: true,
          messageCount: 3,
        },
      }),
      evt({
        span_id: "h1",
        data: { type: "threadEndHooksEnd", timestamp: "", threadId: "t1", timeTaken: 9 },
      }),
    ]);
    expect(forest[0].children[0].label).toBe("threadEndHooks");
  });
});
