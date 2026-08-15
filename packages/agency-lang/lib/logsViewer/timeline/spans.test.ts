import { describe, expect, it } from "vitest";

import { benchForest, leaf, span, trace } from "./fixture.js";
import { ADMIN_KINDS, spanExtent, timelineSpans } from "./spans.js";

const opts = { hideKinds: [] as string[] };

describe("spanExtent", () => {
  it("start honors timeTaken (event emission is the END of the work)", () => {
    const s = span("llmCall", [leaf("promptCompletion", 1_000, { timeTaken: 400 })]);
    expect(spanExtent(s)).toEqual({ start: 600, end: 1_000 });
  });

  it("covers ALL descendant leaves, not just direct children", () => {
    const s = span("toolExecution", [
      leaf("toolCallStart", 100),
      span("llmCall", [leaf("promptCompletion", 900, { timeTaken: 100 })]),
      leaf("toolCall", 950),
    ]);
    expect(spanExtent(s)).toEqual({ start: 100, end: 950 });
  });

  it("no parseable timestamps → undefined", () => {
    expect(spanExtent(span("x", []))).toBeUndefined();
  });
});

describe("timelineSpans", () => {
  it("the 193% regression: a wrapping llm span self-time excludes its children", () => {
    const inner = span("toolExecution", [leaf("toolCallStart", 200), leaf("toolCall", 800)]);
    const outer = span("llmCall", [leaf("promptStart", 0), inner, leaf("promptCompletion", 1_000)]);
    const [outerSpan, innerSpan] = timelineSpans(trace([outer]), opts);
    expect(outerSpan.extent).toEqual({ start: 0, end: 1_000 });
    expect(outerSpan.selfMs).toBe(400);
    expect(innerSpan.selfMs).toBe(600);
  });

  it("selfIntervals carry the actual gaps, not just the right total", () => {
    const inner = span("toolExecution", [leaf("toolCallStart", 200), leaf("toolCall", 800)]);
    const outer = span("llmCall", [leaf("promptStart", 0), inner, leaf("promptCompletion", 1_000)]);
    const [outerSpan] = timelineSpans(trace([outer]), opts);
    expect(outerSpan.selfIntervals).toEqual([
      { start: 0, end: 200 },
      { start: 800, end: 1_000 },
    ]);
  });

  it("depth increments per span level, DFS order", () => {
    const t = trace([
      span("agentRun", [span("nodeExecution", [span("llmCall", [leaf("promptCompletion", 5)])])]),
    ]);
    expect(timelineSpans(t, opts).map((s) => [s.kind, s.depth])).toEqual([
      ["agentRun", 0],
      ["nodeExecution", 1],
      ["llmCall", 2],
    ]);
  });

  it("a span given AS the root appears first at depth 0 (drill-in depends on this)", () => {
    const inner = span("toolExecution", [leaf("toolCallStart", 200), leaf("toolCall", 800)]);
    const outer = span("llmCall", [leaf("promptStart", 0), inner, leaf("promptCompletion", 1_000)]);
    const rows = timelineSpans(outer, opts);
    expect(rows.map((s) => [s.kind, s.depth])).toEqual([
      ["llmCall", 0],
      ["toolExecution", 1],
    ]);
  });

  it("hidden kinds drop rows; survivors keep extent and self-time (guard — cannot fail today)", () => {
    const admin = span("handlerChain", [leaf("handlerDecision", 300)]);
    const tool = span("toolExecution", [leaf("toolCallStart", 100), admin, leaf("toolCall", 500)]);
    const shown = timelineSpans(trace([tool]), { hideKinds: ADMIN_KINDS });
    expect(shown.map((s) => s.kind)).toEqual(["toolExecution"]);
    const all = timelineSpans(trace([tool]), opts);
    expect(shown[0].selfMs).toBe(all[0].selfMs);
    expect(shown[0].extent).toEqual(all[0].extent);
  });

  it("a hidden span's children take its place at ITS depth — no phantom level", () => {
    const inner = span("llmCall", [leaf("promptCompletion", 400)]);
    const admin = span("handlerChain", [leaf("handlerDecision", 300), inner]);
    const tool = span("toolExecution", [leaf("toolCallStart", 100), admin, leaf("toolCall", 500)]);
    const rows = timelineSpans(trace([tool]), { hideKinds: ADMIN_KINDS });
    expect(rows.map((s) => [s.kind, s.depth])).toEqual([
      ["toolExecution", 0],
      ["llmCall", 1],
    ]);
  });

  it("a timestamp-less span is dropped and its children surface at its depth", () => {
    const inner = span("llmCall", [leaf("promptCompletion", 400)]);
    const ghost = span("toolExecution", [inner]);
    // ghost has descendants with timestamps, so give it a truly empty shell:
    const emptyGhost = span("forkAll", []);
    const t = trace([emptyGhost, span("agentRun", [ghost])]);
    const rows = timelineSpans(t, opts);
    // emptyGhost dropped; ghost HAS an extent (via descendant) so it stays.
    expect(rows.map((s) => s.kind)).toEqual(["agentRun", "toolExecution", "llmCall"]);
  });

  it("running spans: start event without its end", () => {
    const runningTool = span("toolExecution", [leaf("toolCallStart", 100)]);
    const doneTool = span("toolExecution", [leaf("toolCallStart", 100), leaf("toolCall", 200)]);
    expect(timelineSpans(trace([runningTool]), opts)[0].running).toBe(true);
    expect(timelineSpans(trace([doneTool]), opts)[0].running).toBe(false);
  });

  it("promptCancelled is a terminus — a cancelled call is not running forever", () => {
    const cancelled = span("llmCall", [leaf("promptStart", 0), leaf("promptCancelled", 100)]);
    const open = span("llmCall", [leaf("promptStart", 0)]);
    expect(timelineSpans(trace([cancelled]), opts)[0].running).toBe(false);
    expect(timelineSpans(trace([open]), opts)[0].running).toBe(true);
  });

  it("a span with no timestamps anywhere is dropped", () => {
    expect(timelineSpans(trace([span("x", [])]), opts)).toEqual([]);
  });

  it("the real trimmed statelog parses into a usable span list", () => {
    const roots = benchForest();
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(timelineSpans(roots[0], opts).length).toBeGreaterThan(20);
  });
});
