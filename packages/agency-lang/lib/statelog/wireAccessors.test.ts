import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "./wireTypes.js";
import {
  byType,
  completionOf,
  cost,
  groupByType,
  modelOf,
  threadIdOf,
  timestampMs,
  toolNameOf,
  toolsOf,
  tokensIn,
  tokensOut,
  userMessageOf,
} from "./wireAccessors.js";

function ev(data: any, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    format_version: 1,
    trace_id: "t",
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { timestamp: "2026-01-01T00:00:00.000Z", ...data },
    ...overrides,
  };
}

describe("groupByType / byType", () => {
  it("groups by data.type in one pass", () => {
    const events = [
      ev({ type: "a" }),
      ev({ type: "b" }),
      ev({ type: "a" }),
    ];
    const grouped = groupByType(events);
    expect(Object.keys(grouped).sort()).toEqual(["a", "b"]);
    expect(grouped.a.length).toBe(2);
    expect(grouped.b.length).toBe(1);
  });

  it("byType filters to one type", () => {
    const events = [ev({ type: "a" }), ev({ type: "b" }), ev({ type: "a" })];
    expect(byType(events, "a").length).toBe(2);
    expect(byType(events, "c")).toEqual([]);
  });
});

describe("timestampMs", () => {
  it("converts ISO timestamp to ms since epoch", () => {
    const e = ev({ type: "x", timestamp: "2026-06-08T00:00:00.000Z" });
    expect(timestampMs(e)).toBe(Date.UTC(2026, 5, 8, 0, 0, 0));
  });
});

describe("threadIdOf", () => {
  it("returns the threadId string when present", () => {
    expect(threadIdOf(ev({ type: "x", threadId: "abc" }))).toBe("abc");
  });

  it("returns null when missing", () => {
    expect(threadIdOf(ev({ type: "x" }))).toBeNull();
  });

  it("returns null when not a string", () => {
    expect(threadIdOf(ev({ type: "x", threadId: 123 }))).toBeNull();
  });
});

describe("toolNameOf", () => {
  it("reads data.toolName", () => {
    expect(toolNameOf(ev({ type: "toolCall", toolName: "grep" }))).toBe("grep");
  });

  it("returns empty string when missing", () => {
    expect(toolNameOf(ev({ type: "toolCall" }))).toBe("");
  });
});

describe("tokensIn / tokensOut / cost", () => {
  it("reads numeric fields with zero fallback", () => {
    const e = ev({
      type: "promptCompletion",
      usage: { inputTokens: 100, outputTokens: 50 },
      cost: { totalCost: 0.0123 },
    });
    expect(tokensIn(e)).toBe(100);
    expect(tokensOut(e)).toBe(50);
    expect(cost(e)).toBeCloseTo(0.0123);
  });

  it("zero when absent", () => {
    const e = ev({ type: "promptCompletion" });
    expect(tokensIn(e)).toBe(0);
    expect(tokensOut(e)).toBe(0);
    expect(cost(e)).toBe(0);
  });
});

describe("modelOf", () => {
  it("returns the model string", () => {
    expect(modelOf(ev({ type: "promptCompletion", model: "gpt-5" }))).toBe(
      "gpt-5",
    );
  });

  it("strips JSON.stringify wrapping quotes", () => {
    expect(
      modelOf(ev({ type: "promptCompletion", model: '"gpt-5"' })),
    ).toBe("gpt-5");
  });

  it("returns empty string when missing", () => {
    expect(modelOf(ev({ type: "promptCompletion" }))).toBe("");
  });
});

describe("toolsOf", () => {
  it("returns names from {name: ...} entries", () => {
    const e = ev({
      type: "promptCompletion",
      tools: [{ name: "grep" }, { name: "read" }],
    });
    expect(toolsOf(e)).toEqual(["grep", "read"]);
  });

  it("returns [] when no tools array", () => {
    expect(toolsOf(ev({ type: "promptCompletion" }))).toEqual([]);
  });
});

describe("userMessageOf", () => {
  it("returns the last user-role message content", () => {
    const e = ev({
      type: "promptCompletion",
      messages: [
        { role: "system", content: "you are an agent" },
        { role: "user", content: "hello" },
      ],
    });
    expect(userMessageOf(e)).toBe("hello");
  });

  it("returns the LAST user message when several exist", () => {
    const e = ev({
      type: "promptCompletion",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "..." },
        { role: "user", content: "second" },
      ],
    });
    expect(userMessageOf(e)).toBe("second");
  });

  it("handles array-of-parts content shape", () => {
    const e = ev({
      type: "promptCompletion",
      messages: [
        {
          role: "user",
          content: [{ text: "hello " }, { text: "world" }],
        },
      ],
    });
    expect(userMessageOf(e)).toBe("hello world");
  });

  it("returns null when no user message", () => {
    expect(
      userMessageOf(
        ev({ type: "promptCompletion", messages: [{ role: "system", content: "x" }] }),
      ),
    ).toBeNull();
  });

  it("returns null when no messages array", () => {
    expect(userMessageOf(ev({ type: "promptCompletion" }))).toBeNull();
  });
});

describe("completionOf", () => {
  it("returns string completion", () => {
    expect(
      completionOf(ev({ type: "promptCompletion", completion: "hi" })),
    ).toBe("hi");
  });

  it("returns completion.output", () => {
    expect(
      completionOf(
        ev({ type: "promptCompletion", completion: { output: "hi" } }),
      ),
    ).toBe("hi");
  });

  it("returns choices[0].message.content fallback", () => {
    expect(
      completionOf(
        ev({
          type: "promptCompletion",
          completion: { choices: [{ message: { content: "hi" } }] },
        }),
      ),
    ).toBe("hi");
  });

  it("returns null for empty string", () => {
    expect(
      completionOf(ev({ type: "promptCompletion", completion: "" })),
    ).toBeNull();
  });

  it("returns null when no completion", () => {
    expect(completionOf(ev({ type: "promptCompletion" }))).toBeNull();
  });
});
