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

    it("evalInputs / evalOutputs populated from heuristic", () => {
      expect(rec.evalInputs.at(-1)?.value).toBe("do the thing");
      expect(rec.evalInputs.at(-1)?.threadId).toBe("0");
      expect(rec.evalOutputs.at(-1)?.value).toBe("done.");
      expect(rec.evalOutputs.at(-1)?.threadId).toBe("0");
      expect(
        rec.warnings.some((w) => w.includes("Call evalInput(prompt)")),
      ).toBe(true);
      expect(
        rec.warnings.some((w) => w.includes("Call evalOutput(reply)")),
      ).toBe(true);
    });

    it("traceId / formatVersion / source / recordVersion", () => {
      expect(rec.traceId).toBe("trace-A");
      expect(rec.formatVersion).toBe(1);
      expect(rec.source).toBe("test:A");
      expect(rec.recordVersion).toBe(2);
    });

    it("only warns about heuristic eval extraction", () => {
      expect(rec.warnings).toEqual([
        expect.stringContaining("Call evalInput(prompt)"),
        expect.stringContaining("Call evalOutput(reply)"),
      ]);
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

    it("only warns about the heuristic eval input it can extract", () => {
      expect(rec.warnings).toEqual([
        expect.stringContaining("Call evalInput(prompt)"),
      ]);
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

    it("evalInputs uses the TOP-LEVEL thread's user prompt, not the subagent's", () => {
      expect(rec.evalInputs[0].value).toBe("delegate");
      expect(rec.evalInputs[0].threadId).toBe("0");
    });

    it("evalOutputs uses the TOP-LEVEL thread's last completion, not the subagent's", () => {
      expect(rec.evalOutputs[0].value).toBe("delegating");
      expect(rec.evalOutputs[0].threadId).toBe("0");
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

    it("falls back to all promptCompletions for evalInputs / evalOutputs", () => {
      expect(rec.evalInputs[0].value).toBe("hello");
      expect(rec.evalInputs[0].threadId).toBeNull();
      expect(rec.evalOutputs[0].value).toBe("hi");
      expect(rec.evalOutputs[0].threadId).toBeNull();
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

  describe("explicit eval annotation extraction", () => {
    it("uses explicit evalInputRecorded / evalOutputRecorded events without fallback warnings", () => {
      resetClock();
      const events: EventEnvelope[] = [
        ev("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
        ev("evalInputRecorded", { threadId: "0", value: { prompt: "real input" } }),
        ev("evalOutputRecorded", { threadId: "0", value: "real output" }),
      ];
      const rec = extractEvalRecord(events, "test:explicit");

      expect(rec.evalInputs).toEqual([
        { value: { prompt: "real input" }, threadId: "0", tMs: 100 },
      ]);
      expect(rec.evalOutputs).toEqual([
        { value: "real output", threadId: "0", tMs: 200 },
      ]);
      expect(rec.warnings).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/Call eval(Input|Output)/)]),
      );
    });

    it("preserves chronological order for multiple firings", () => {
      resetClock();
      const events: EventEnvelope[] = [
        ev("evalInputRecorded", { threadId: "0", value: "first in" }),
        ev("evalOutputRecorded", { threadId: "0", value: "first out" }),
        ev("evalInputRecorded", { threadId: "0", value: "second in" }),
        ev("evalOutputRecorded", { threadId: "0", value: "second out" }),
      ];
      const rec = extractEvalRecord(events, "test:multiple");

      expect(rec.evalInputs.map((v) => v.value)).toEqual(["first in", "second in"]);
      expect(rec.evalOutputs.map((v) => v.value)).toEqual([
        "first out",
        "second out",
      ]);
    });

    it("emits no eval warnings when neither explicit events nor promptCompletions exist", () => {
      resetClock();
      const rec = extractEvalRecord([ev("agentStart", { entryNode: "main" })], "test:none");

      expect(rec.evalInputs).toEqual([]);
      expect(rec.evalOutputs).toEqual([]);
      expect(rec.warnings).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/eval(Input|Output)\(\)/)]),
      );
    });

    it("mixes explicit output with heuristic input", () => {
      resetClock();
      const events: EventEnvelope[] = [
        ev("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
        ev(
          "promptCompletion",
          {
            threadId: "0",
            model: "gpt-5",
            messages: [{ role: "user", content: "heuristic input" }],
            completion: { output: "raw llm output" },
          },
          "span-llm",
        ),
        ev("evalOutputRecorded", { threadId: "0", value: "real output" }),
      ];
      const rec = extractEvalRecord(events, "test:mixed");

      expect(rec.evalInputs).toEqual([
        { value: "heuristic input", threadId: "0", tMs: 100 },
      ]);
      expect(rec.evalOutputs).toEqual([
        { value: "real output", threadId: "0", tMs: 200 },
      ]);
      expect(rec.warnings).toEqual([
        expect.stringContaining("Call evalInput(prompt)"),
      ]);
    });

    it("truncates oversized explicit values without mutating smaller entries", () => {
      resetClock();
      const huge = "x".repeat(100_100);
      const events: EventEnvelope[] = [
        ev("evalInputRecorded", { threadId: "0", value: huge }),
        ev("evalInputRecorded", { threadId: "0", value: "small" }),
        ev("evalOutputRecorded", { threadId: "0", value: "ok" }),
      ];
      const rec = extractEvalRecord(events, "test:truncate");

      expect(rec.evalInputs[0].truncated).toBe(true);
      expect(typeof rec.evalInputs[0].value).toBe("string");
      expect(String(rec.evalInputs[0].value)).toContain("[truncated");
      expect(String(rec.evalInputs[0].value).length).toBeLessThan(huge.length);
      expect(rec.evalInputs[1]).toEqual({
        value: "small",
        threadId: "0",
        tMs: 100,
      });
    });

    it("truncates oversized strings as readable string content", () => {
      resetClock();
      const huge = "actual text ".repeat(10_000);
      const rec = extractEvalRecord(
        [ev("evalOutputRecorded", { threadId: "0", value: huge })],
        "test:truncate-string",
      );

      expect(rec.evalOutputs[0].truncated).toBe(true);
      expect(String(rec.evalOutputs[0].value).startsWith("actual text ")).toBe(true);
      expect(String(rec.evalOutputs[0].value).startsWith('"actual text')).toBe(false);
    });

    it("caps truncated unicode values by UTF-8 bytes", () => {
      resetClock();
      const huge = "🙂".repeat(40_000);
      const rec = extractEvalRecord(
        [ev("evalOutputRecorded", { threadId: "0", value: huge })],
        "test:truncate-unicode",
      );

      const truncated = String(rec.evalOutputs[0].value);
      expect(rec.evalOutputs[0].truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(truncated), "utf8")).toBeLessThanOrEqual(
        100_000,
      );
    });

    it("preserves subagent explicit evalOutputRecorded firings", () => {
      resetClock();
      const events: EventEnvelope[] = [
        ev("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
        ev("threadCreated", {
          threadId: "1",
          threadType: "subthread",
          parentThreadId: "0",
          label: "worker",
        }),
        ev("evalOutputRecorded", { threadId: "1", value: "subagent output" }),
      ];
      const rec = extractEvalRecord(events, "test:subagent-explicit");

      expect(rec.evalOutputs).toEqual([
        { value: "subagent output", threadId: "1", tMs: 200 },
      ]);
    });
  });
});
