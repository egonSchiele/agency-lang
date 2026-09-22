import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "./wireTypes.js";
import {
  byType,
  completionOf,
  contextTokens,
  cost,
  groupByType,
  modelOf,
  threadIdOf,
  threadIdentityOf,
  threadLabelOf,
  timestampMs,
  toolNameOf,
  toolReplyContent,
  toolsOf,
  tokensIn,
  tokensCached,
  tokensCacheWrite,
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
    const events = [ev({ type: "a" }), ev({ type: "b" }), ev({ type: "a" })];
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

describe("recorded thread metadata", () => {
  it("reads non-empty identity and label strings", () => {
    const event = ev({ type: "promptCompletion", threadIdentity: "stable", threadLabel: "worker" });
    expect(threadIdentityOf(event)).toBe("stable");
    expect(threadLabelOf(event)).toBe("worker");
  });

  it("returns null for missing, empty, or non-string values", () => {
    expect(threadIdentityOf(ev({ type: "promptCompletion" }))).toBeNull();
    expect(threadIdentityOf(ev({ type: "promptCompletion", threadIdentity: "" }))).toBeNull();
    expect(threadLabelOf(ev({ type: "promptCompletion", threadLabel: 7 }))).toBeNull();
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

describe("the cached token bands", () => {
  const event = ev({
    type: "promptCompletion",
    usage: {
      inputTokens: 95,
      outputTokens: 190,
      cachedInputTokens: 13824,
      cacheCreationInputTokens: 40,
      totalTokens: 14149,
    },
  });

  it("reads each band separately", () => {
    expect(tokensIn(event)).toBe(95);
    expect(tokensCached(event)).toBe(13824);
    expect(tokensCacheWrite(event)).toBe(40);
    expect(tokensOut(event)).toBe(190);
  });

  it("contextTokens is every input band, and leaves output out", () => {
    expect(contextTokens(event)).toBe(95 + 13824 + 40);
  });

  it("an old event with no cache fields counts them as zero", () => {
    const old = ev({
      type: "promptCompletion",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(tokensCached(old)).toBe(0);
    expect(contextTokens(old)).toBe(100);
  });

  it("an event with no usage at all is zero, not NaN", () => {
    expect(contextTokens(ev({ type: "promptCompletion" }))).toBe(0);
  });
});

describe("modelOf", () => {
  it("returns the model string", () => {
    expect(modelOf(ev({ type: "promptCompletion", model: "gpt-5" }))).toBe("gpt-5");
  });

  it("strips JSON.stringify wrapping quotes", () => {
    expect(modelOf(ev({ type: "promptCompletion", model: '"gpt-5"' }))).toBe("gpt-5");
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
      userMessageOf(ev({ type: "promptCompletion", messages: [{ role: "system", content: "x" }] })),
    ).toBeNull();
  });

  it("returns null when no messages array", () => {
    expect(userMessageOf(ev({ type: "promptCompletion" }))).toBeNull();
  });
});

describe("completionOf", () => {
  it("returns string completion", () => {
    expect(completionOf(ev({ type: "promptCompletion", completion: "hi" }))).toBe("hi");
  });

  it("returns completion.output", () => {
    expect(completionOf(ev({ type: "promptCompletion", completion: { output: "hi" } }))).toBe("hi");
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
    expect(completionOf(ev({ type: "promptCompletion", completion: "" }))).toBeNull();
  });

  it("returns null when no completion", () => {
    expect(completionOf(ev({ type: "promptCompletion" }))).toBeNull();
  });
});

it("keeps model reply values and unwraps only the producer's outer successful Result", () => {
  const object = { errors: [], warnings: [] };
  const nested = { __type: "resultType", success: true, value: 42 };
  const outputEvent = (output: unknown) => ev({ type: "toolCall", output });
  expect(toolReplyContent(outputEvent(object))).toEqual(object);
  expect(toolReplyContent(outputEvent(42))).toBe(42);
  expect(
    toolReplyContent(outputEvent({ __type: "resultType", success: true, value: nested })),
  ).toEqual(nested);
  expect(
    toolReplyContent(outputEvent({ __type: "resultType", success: false, message: "failed" })),
  ).toBeUndefined();
});

it("does not turn image-only or object user messages into JSON text", () => {
  for (const content of [
    [{ type: "image", data: "base64-content" }],
    { image: "base64-content" },
  ]) {
    expect(
      userMessageOf(ev({ type: "promptCompletion", messages: [{ role: "user", content }] })),
    ).toBeNull();
  }
  expect(
    userMessageOf(
      ev({
        type: "promptCompletion",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", data: "base64" },
              { type: "text", text: "look here" },
            ],
          },
        ],
      }),
    ),
  ).toBe("look here");
});
