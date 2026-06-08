import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../statelog/wireTypes.js";
import { extractEvalRecord } from "./extract.js";

let _ts = 0;
function nextTs(): string {
  _ts += 100;
  return new Date(1_700_000_000_000 + _ts).toISOString();
}
function resetClock(): void {
  _ts = 0;
}

function ev(
  type: string,
  data: any = {},
  spanId: string | null = null,
  parentSpanId: string | null = null,
): EventEnvelope {
  return {
    format_version: 1,
    trace_id: "trace-A",
    project_id: "p",
    span_id: spanId,
    parent_span_id: parentSpanId,
    data: { type, timestamp: nextTs(), ...data },
  };
}

describe("extractEvalRecord", () => {
  it("throws on empty input", () => {
    expect(() => extractEvalRecord([], "src")).toThrow(/no events/);
  });

  it("rejects multi-trace input", () => {
    resetClock();
    const a = ev("promptCompletion", { threadId: "0" });
    const b: EventEnvelope = { ...ev("promptCompletion", { threadId: "0" }), trace_id: "trace-B" };
    expect(() => extractEvalRecord([a, b], "src")).toThrow(/multiple trace_ids/i);
  });

  describe("fixture A — trivial: one thread, one prompt, one tool pair", () => {
    resetClock();
    const events: EventEnvelope[] = [
      ev("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
      ev(
        "promptCompletion",
        {
          threadId: "0",
          model: '"gpt-5"',
          messages: [
            { role: "system", content: "you are an agent" },
            { role: "user", content: "do the thing" },
          ],
          completion: { output: "done." },
          usage: { inputTokens: 10, outputTokens: 5 },
          cost: { totalCost: 0.0001 },
          timeTaken: 250,
          tools: [{ name: "grep" }],
        },
        "span-llm",
      ),
      ev(
        "toolCallStart",
        { threadId: "0", toolName: "grep", args: { pattern: "x" } },
        "span-tool-1",
        "span-llm",
      ),
      ev(
        "toolCall",
        {
          threadId: "0",
          toolName: "grep",
          args: { pattern: "x" },
          output: "found",
          timeTaken: 12,
        },
        "span-tool-1",
        "span-llm",
      ),
    ];
    const rec = extractEvalRecord(events, "test:A");

    it("has one thread", () => {
      expect(rec.threads.length).toBe(1);
      expect(rec.threads[0].label).toBe("main");
      expect(rec.threads[0].threadId).toBe("0");
    });

    it("has three normalized events (llm + tool_start + tool_end)", () => {
      expect(rec.events.length).toBe(3);
      expect(rec.events.map((e) => e.kind)).toEqual([
        "llm",
        "tool_start",
        "tool_end",
      ]);
    });

    it("each normalized event has a non-null threadId", () => {
      for (const e of rec.events) expect(e.threadId).toBe("0");
    });

    it("populates metrics correctly", () => {
      expect(rec.metrics.llmCalls).toBe(1);
      expect(rec.metrics.toolStarts).toBe(1);
      expect(rec.metrics.toolEnds).toBe(1);
      expect(rec.metrics.models).toEqual(["gpt-5"]);
      expect(rec.metrics.tokensInTotal).toBe(10);
      expect(rec.metrics.tokensOutTotal).toBe(5);
      expect(rec.metrics.costUsdTotal).toBeCloseTo(0.0001);
      expect(rec.metrics.toolCounts).toEqual({ grep: 1 });
    });

    it("incomplete is empty", () => {
      expect(rec.incomplete).toEqual([]);
    });

    it("userMessage / finalResponse populated", () => {
      expect(rec.userMessage).toBe("do the thing");
      expect(rec.finalResponse).toBe("done.");
    });

    it("traceId / formatVersion / source / recordVersion", () => {
      expect(rec.traceId).toBe("trace-A");
      expect(rec.formatVersion).toBe(1);
      expect(rec.source).toBe("test:A");
      expect(rec.recordVersion).toBe(1);
    });

    it("no warnings", () => {
      expect(rec.warnings).toEqual([]);
    });
  });

  describe("fixture B — toolCallStart with no matching toolCall (killed)", () => {
    resetClock();
    const events: EventEnvelope[] = [
      ev("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
      ev(
        "promptCompletion",
        { threadId: "0", model: "gpt-5", messages: [{ role: "user", content: "x" }], completion: { output: "" } },
        "span-llm",
      ),
      ev(
        "toolCallStart",
        { threadId: "0", toolName: "expensive_tool", args: {} },
        "span-tool-X",
        "span-llm",
      ),
      // no matching toolCall — process killed mid-tool
    ];
    const rec = extractEvalRecord(events, "test:B");

    it("incomplete has the killed tool", () => {
      expect(rec.incomplete.length).toBe(1);
      expect(rec.incomplete[0].tool).toBe("expensive_tool");
      expect(rec.incomplete[0].threadId).toBe("0");
      expect(rec.incomplete[0].spanId).toBe("span-tool-X");
    });

    it("metrics.toolStarts > toolEnds", () => {
      expect(rec.metrics.toolStarts).toBe(1);
      expect(rec.metrics.toolEnds).toBe(0);
    });

    it("warnings empty", () => {
      expect(rec.warnings).toEqual([]);
    });
  });

  describe("fixture C — nested: main thread calls a subagent that calls a tool", () => {
    resetClock();
    const events: EventEnvelope[] = [
      ev("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
      ev(
        "promptCompletion",
        { threadId: "0", model: "gpt-5", messages: [{ role: "user", content: "delegate" }], completion: { output: "delegating" } },
        "span-llm-main",
      ),
      ev("threadCreated", {
        threadId: "1",
        threadType: "subthread",
        parentThreadId: "0",
        label: "explorer",
      }),
      ev(
        "promptCompletion",
        { threadId: "1", model: "gpt-5", messages: [{ role: "user", content: "sub-prompt" }], completion: { output: "did a search" } },
        "span-llm-sub",
      ),
      ev(
        "toolCallStart",
        { threadId: "1", toolName: "grep", args: { pattern: "x" } },
        "span-tool-S",
        "span-llm-sub",
      ),
      ev(
        "toolCall",
        { threadId: "1", toolName: "grep", args: {}, output: "ok", timeTaken: 3 },
        "span-tool-S",
        "span-llm-sub",
      ),
    ];
    const rec = extractEvalRecord(events, "test:C");

    it("captures parent → child thread relationship", () => {
      const sub = rec.threads.find((t) => t.threadId === "1");
      expect(sub).toBeDefined();
      expect(sub!.parentThreadId).toBe("0");
      expect(sub!.label).toBe("explorer");
    });

    it("tool_start / tool_end attribute to the subagent thread", () => {
      const toolEvents = rec.events.filter(
        (e) => e.kind === "tool_start" || e.kind === "tool_end",
      );
      for (const e of toolEvents) expect(e.threadId).toBe("1");
    });

    it("userMessage is the TOP-LEVEL thread's user prompt, not the subagent's", () => {
      expect(rec.userMessage).toBe("delegate");
    });

    it("finalResponse is the TOP-LEVEL thread's last completion, not the subagent's", () => {
      expect(rec.finalResponse).toBe("delegating");
    });
  });

  describe("legacy / graceful degradation", () => {
    resetClock();
    const events: EventEnvelope[] = [
      ev("threadCreated", { threadId: "0", threadType: "thread" }),
      // No threadId on tool/LLM events — pre-Task-0 trace.
      ev(
        "promptCompletion",
        {
          model: "gpt-5",
          messages: [{ role: "user", content: "hello" }],
          completion: { output: "hi" },
        },
        "span-llm",
      ),
      ev("toolCall", { toolName: "grep", args: {}, output: "" }, "span-tool", "span-llm"),
    ];
    const rec = extractEvalRecord(events, "test:legacy");

    it("does not throw; warns about missing threadId", () => {
      expect(rec.warnings.length).toBeGreaterThan(0);
      expect(rec.warnings.some((w) => /no threadId field/i.test(w))).toBe(true);
    });

    it("falls back to all promptCompletions for userMessage / finalResponse", () => {
      expect(rec.userMessage).toBe("hello");
      expect(rec.finalResponse).toBe("hi");
    });

    it("attributes tool/LLM events with null threadId", () => {
      const tool = rec.events.find((e) => e.kind === "tool_end");
      expect(tool?.threadId).toBeNull();
    });
  });

  describe("interrupt grouping", () => {
    resetClock();
    const events: EventEnvelope[] = [
      ev(
        "interruptThrown",
        { interruptId: "i-1", interruptData: { foo: "bar" } },
        "span-i",
      ),
      ev("handlerDecision", {
        interruptId: "i-1",
        handlerIndex: 0,
        decision: "approve",
        interrupt: { kind: "approval", message: "Run grep?", data: { tool: "grep" } },
      }),
      ev("interruptResolved", {
        interruptId: "i-1",
        outcome: "approved",
        resolvedBy: "handler",
        interrupt: { kind: "approval", message: "Run grep?", data: { tool: "grep" } },
      }),
    ];
    const rec = extractEvalRecord(events, "test:interrupts");

    it("produces one entry per interruptId with summary fields populated", () => {
      expect(rec.interrupts.length).toBe(1);
      const [i] = rec.interrupts;
      expect(i.interruptId).toBe("i-1");
      expect(i.outcome).toBe("approved");
      expect(i.resolvedBy).toBe("handler");
      expect(i.kind).toBe("approval");
      expect(i.message).toBe("Run grep?");
      expect(i.data).toEqual({ tool: "grep" });
      expect(i.thrownAtMs).not.toBeNull();
      expect(i.resolvedAtMs).not.toBeNull();
    });
  });

  describe("preview truncation", () => {
    resetClock();
    const longArgs = "x".repeat(500);
    const events: EventEnvelope[] = [
      ev("threadCreated", { threadId: "0", threadType: "thread" }),
      ev(
        "toolCallStart",
        { threadId: "0", toolName: "grep", args: { pattern: longArgs } },
        "span-tool",
      ),
      ev(
        "toolCall",
        { threadId: "0", toolName: "grep", args: {}, output: longArgs },
        "span-tool",
      ),
    ];

    it("truncates to default 200 chars", () => {
      const rec = extractEvalRecord(events, "test:preview");
      const start = rec.events.find((e) => e.kind === "tool_start");
      const end = rec.events.find((e) => e.kind === "tool_end");
      // Truncation produces "...…" so length is exactly the limit.
      expect((start as any).argsPreview.length).toBe(200);
      expect((end as any).outputPreview.length).toBe(200);
    });

    it("previewChars: 0 means no truncation", () => {
      const rec = extractEvalRecord(events, "test:preview", { previewChars: 0 });
      const end = rec.events.find((e) => e.kind === "tool_end");
      expect((end as any).outputPreview.length).toBeGreaterThan(400);
    });
  });
});
