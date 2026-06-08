import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../statelog/wireTypes.js";
import { extractThreads, normalize } from "./normalize.js";

function ev(
  type: string,
  data: any = {},
  ts: string = "2026-01-01T00:00:00.000Z",
  spanId: string | null = null,
  parentSpanId: string | null = null,
): EventEnvelope {
  return {
    format_version: 1,
    trace_id: "t",
    project_id: "p",
    span_id: spanId,
    parent_span_id: parentSpanId,
    data: { type, timestamp: ts, ...data },
  };
}

describe("normalize", () => {
  it("returns empty result for empty input", () => {
    const n = normalize([]);
    expect(n.events).toEqual([]);
    expect(n.byType).toEqual({});
    expect(n.spanIndex).toEqual({});
    expect(n.warnings).toEqual([]);
  });

  it("computes tMs relative to the first event", () => {
    const n = normalize([
      ev("a", {}, "2026-01-01T00:00:00.000Z"),
      ev("b", {}, "2026-01-01T00:00:01.500Z"),
      ev("c", {}, "2026-01-01T00:00:02.000Z"),
    ]);
    expect(n.events.map((e) => e.tMs)).toEqual([0, 1500, 2000]);
  });

  it("hoists threadId from data.threadId", () => {
    const n = normalize([
      ev("promptCompletion", { threadId: "t-0" }),
      ev("promptCompletion", {}),
    ]);
    expect(n.events[0].threadId).toBe("t-0");
    expect(n.events[1].threadId).toBeNull();
  });

  it("builds spanIndex keyed by span_id", () => {
    const n = normalize([
      ev("a", {}, "2026-01-01T00:00:00.000Z", "span-1"),
      ev("b", {}, "2026-01-01T00:00:00.000Z", null),
      ev("c", {}, "2026-01-01T00:00:00.000Z", "span-2", "span-1"),
    ]);
    expect(Object.keys(n.spanIndex).sort()).toEqual(["span-1", "span-2"]);
    expect(n.spanIndex["span-2"].parentSpanId).toBe("span-1");
  });

  it("groups events by type", () => {
    const n = normalize([
      ev("promptCompletion"),
      ev("toolCall"),
      ev("toolCall"),
      ev("threadCreated"),
    ]);
    expect(n.byType.promptCompletion.length).toBe(1);
    expect(n.byType.toolCall.length).toBe(2);
    expect(n.byType.threadCreated.length).toBe(1);
  });

  it("emits a warning when tool/LLM events lack threadId (legacy trace)", () => {
    const n = normalize([
      ev("promptCompletion"),
      ev("toolCall"),
    ]);
    expect(n.warnings.length).toBe(1);
    expect(n.warnings[0]).toContain("no threadId field");
  });

  it("does not warn when any tool/LLM event has threadId", () => {
    const n = normalize([
      ev("promptCompletion", { threadId: "t-0" }),
      ev("toolCall"),
    ]);
    expect(n.warnings).toEqual([]);
  });

  it("does not warn when there are no tool/LLM events at all", () => {
    const n = normalize([ev("threadCreated", { threadId: "0" })]);
    expect(n.warnings).toEqual([]);
  });
});

describe("extractThreads", () => {
  it("one entry per threadCreated", () => {
    const n = normalize([
      ev("threadCreated", {
        threadId: "0",
        threadType: "thread",
        label: "main",
        session: null,
        hidden: false,
      }),
      ev("threadCreated", {
        threadId: "1",
        threadType: "subthread",
        parentThreadId: "0",
        label: "explorer",
        hidden: false,
      }),
    ]);
    const threads = extractThreads(n);
    expect(threads.length).toBe(2);
    expect(threads[0]).toEqual({
      threadId: "0",
      threadType: "thread",
      parentThreadId: null,
      label: "main",
      session: null,
      hidden: false,
      createdAtMs: 0,
    });
    expect(threads[1].parentThreadId).toBe("0");
    expect(threads[1].label).toBe("explorer");
  });

  it("threadResumed events do not create entries", () => {
    const n = normalize([
      ev("threadCreated", { threadId: "0", threadType: "thread" }),
      ev("threadResumed", { threadId: "0" }),
    ]);
    expect(extractThreads(n).length).toBe(1);
  });

  it("handles missing label/session/hidden", () => {
    const n = normalize([
      ev("threadCreated", { threadId: "0", threadType: "thread" }),
    ]);
    const [t] = extractThreads(n);
    expect(t.label).toBeNull();
    expect(t.session).toBeNull();
    expect(t.hidden).toBe(false);
  });
});
