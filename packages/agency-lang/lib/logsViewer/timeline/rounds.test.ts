import { describe, expect, it } from "vitest";

import { benchForest, leaf, span, trace } from "./fixture.js";
import { parseRoundId, roundId, roundsOf, sameThread } from "./rounds.js";

function completion(at: number, data: Record<string, unknown> = {}) {
  return leaf("promptCompletion", at, {
    model: '"m1"',
    threadId: "1",
    timeTaken: 100,
    ...data,
  });
}

describe("roundsOf", () => {
  it("makes one round per completion, inside one llmCall span", () => {
    const root = trace([
      span("llmCall", [completion(1000), completion(2000), completion(3000)], { id: "L" }),
    ]);
    const rounds = roundsOf(root);
    expect(rounds.map((round) => round.id)).toEqual(["round:L:0", "round:L:1", "round:L:2"]);
    expect(rounds.map((round) => round.index)).toEqual([0, 1, 2]);
    expect(rounds[0]).toMatchObject({ start: 900, end: 1000, durationMs: 100, model: "m1" });
  });

  it("splits input into cached and fresh, and counts cache writes as fresh", () => {
    const root = trace([
      span(
        "llmCall",
        [
          completion(1000, {
            usage: {
              inputTokens: 95,
              outputTokens: 190,
              cachedInputTokens: 13824,
              cacheCreationInputTokens: 40,
            },
            cost: { totalCost: 0.0015 },
          }),
        ],
        { id: "L" },
      ),
    ]);
    expect(roundsOf(root)[0]).toMatchObject({
      cachedTokens: 13824,
      freshTokens: 135,
      outputTokens: 190,
      contextTokens: 13959,
      costUsd: 0.0015,
    });
  });

  it("numbers rounds across threads by when they finished", () => {
    const root = trace([
      span("llmCall", [completion(1000, { threadId: "1" }), completion(4000, { threadId: "1" })], {
        id: "A",
      }),
      span("llmCall", [completion(2500, { threadId: "2" })], { id: "B" }),
    ]);
    expect(roundsOf(root).map((round) => round.id)).toEqual([
      "round:A:0",
      "round:B:0",
      "round:A:1",
    ]);
  });

  it("names a thread from threadCreated", () => {
    const root = trace([
      leaf("threadCreated", 0, { threadId: "1", label: "codingAgent" }),
      span("llmCall", [completion(1000)], { id: "L" }),
    ]);
    expect(roundsOf(root)[0].threadLabel).toBe("codingAgent");
  });

  it("keeps a subprocess's thread 1 apart from its parent's thread 1", () => {
    const parent = span("llmCall", [completion(1000)], { id: "P" });
    const child = span("llmCall", [completion(2000)], { id: "C" });
    const sub = span("subprocessRun", [leaf("subprocessStarted", 1500), child], { id: "S" });
    const [first, second] = roundsOf(trace([parent, sub]));
    expect(first.thread).toEqual({ kind: "legacy", id: JSON.stringify(["T", "P", "1"]) });
    expect(second.thread).toEqual({ kind: "legacy", id: JSON.stringify(["T", "C", "1"]) });
    expect(sameThread(first, second)).toBe(false);
  });

  it("uses identity across spans, while separating fresh stores with the same local id", () => {
    const root = trace([
      span("llmCall", [completion(1000, { threadId: "0", threadIdentity: "parent" })], {
        id: "P",
      }),
      span("llmCall", [completion(2000, { threadId: "0", threadIdentity: "child" })], {
        id: "C",
      }),
      span("llmCall", [completion(3000, { threadId: "0", threadIdentity: "parent" })], {
        id: "H",
      }),
    ]);
    const [parent, child, handoff] = roundsOf(root);
    expect(sameThread(parent, child)).toBe(false);
    expect(sameThread(parent, handoff)).toBe(true);
  });

  it("does not merge legacy local ids across different spans in one process", () => {
    const root = trace([
      span("llmCall", [completion(1000, { threadId: "0" })], { id: "P" }),
      span("llmCall", [completion(2000, { threadId: "0" })], { id: "C" }),
    ]);
    const [parent, child] = roundsOf(root);
    expect(sameThread(parent, child)).toBe(false);
  });

  it("gives earlier rounds the same id after more events arrive", () => {
    const before = trace([span("llmCall", [completion(1000)], { id: "L" })]);
    const after = trace([
      span("llmCall", [completion(1000), leaf("promptStart", 1500), completion(2000)], {
        id: "L",
      }),
    ]);
    expect(roundsOf(after)[0].id).toBe(roundsOf(before)[0].id);
  });

  it("skips a completion whose timestamp cannot be read", () => {
    const bad = leaf("promptCompletion", 1000, { threadId: "1" });
    bad.event!.data.timestamp = "not a date";
    expect(roundsOf(trace([span("llmCall", [bad], { id: "L" })]))).toEqual([]);
  });

  it("finds rounds in the bench statelog, in end order, with unique ids", () => {
    const rounds = benchForest().flatMap((root) => roundsOf(root));
    expect(rounds.length).toBeGreaterThan(0);
    const ids = rounds.map((round) => round.id);
    expect(ids.filter((id, index) => ids.indexOf(id) === index)).toHaveLength(ids.length);
    expect(rounds.map((round) => round.end)).toEqual(
      rounds.map((round) => round.end).sort((first, second) => first - second),
    );
  });
});

describe("round ids", () => {
  it("round-trip, including a span id that contains a colon", () => {
    expect(parseRoundId(roundId("a:b", 3))).toEqual({ spanId: "a:b", ordinal: 3 });
  });

  it("anything else is not a round id", () => {
    expect(parseRoundId("L")).toBeUndefined();
    expect(parseRoundId("round:L:x")).toBeUndefined();
    expect(parseRoundId("round:L:")).toBeUndefined();
    expect(parseRoundId("round:L: ")).toBeUndefined();
    expect(parseRoundId("round:L:1e2")).toBeUndefined();
    expect(parseRoundId("round::0")).toBeUndefined();
  });
});
