import { describe, it, expect, vi } from "vitest";
import { success, failure } from "smoltalk";
import {
  DecisionCollector,
  questionKey,
  splitCounts,
  type DecisionRequest,
  type CollectorHooks,
} from "./decisionCollector.js";
import type { DecideResult, DecisionAnswer } from "./llmClient.js";

const choice = (value: string): DecisionAnswer => ({
  type: "choice",
  choice: value,
  confidence: 0.9,
  probabilities: { [value]: 0.9 },
});

function request(over: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    state: [{ role: "user", content: "ticket" }],
    questions: { answer: { type: "choice", instructions: "?", criteria: { a: "a", b: "b" } } },
    config: { model: "jev-1.13", provider: "typesafe" },
    questionCap: 64,
    signal: new AbortController().signal,
    ...over,
  };
}

/** A sender that answers every question it is asked with choice "a" and
 *  reports 10 input tokens, recording each request. */
function sender(calls: Array<{ questions: Record<string, unknown>; state: unknown }>) {
  return vi.fn(async (state: unknown, questions: Record<string, unknown>) => {
    calls.push({ questions, state });
    const answers: Record<string, DecisionAnswer> = {};
    for (const name of Object.keys(questions)) answers[name] = choice("a");
    const value: DecideResult = {
      answers,
      usage: { inputTokens: 10, outputTokens: 0 },
      cost: { inputCost: 0.001, outputCost: 0, totalCost: 0.001, currency: "USD" },
      model: "jev-1.13",
    };
    return success(value);
  });
}

function hooks(): CollectorHooks & { ended: number; caps: number } {
  const h = {
    ended: 0,
    caps: 0,
    batchStarted: () => () => {
      h.ended++;
    },
    capReached: () => {
      h.caps++;
    },
  };
  return h;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DecisionCollector", () => {
  it("does not send while an arm is still running", async () => {
    const calls: any[] = [];
    const collector = new DecisionCollector(["a", "b"], sender(calls), hooks());
    const pending = collector.submit("a", request());
    await tick();
    expect(calls).toHaveLength(0);
    collector.armSettled("b");
    const result = await pending;
    expect(calls).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it("sends the calls of two waiting arms as one request and hands each its own answers", async () => {
    const calls: any[] = [];
    const collector = new DecisionCollector(["a", "b"], sender(calls), hooks());
    const first = collector.submit("a", request());
    const second = collector.submit("b", request());
    const [r1, r2] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions).sort()).toEqual([
      questionKey(1, "answer"),
      questionKey(2, "answer"),
    ]);
    if (!r1.success || !r2.success) throw new Error("expected answers");
    expect(Object.keys(r1.value.answers)).toEqual(["answer"]);
    expect(Object.keys(r2.value.answers)).toEqual(["answer"]);
  });

  it("splits usage and cost by question count", async () => {
    const calls: any[] = [];
    const collector = new DecisionCollector(["a", "b"], sender(calls), hooks());
    const two = {
      x: { type: "noul" as const, instructions: "?" },
      y: { type: "noul" as const, instructions: "?" },
    };
    const [r1, r2] = await Promise.all([
      collector.submit("a", request({ questions: two })),
      collector.submit("b", request()),
    ]);
    if (!r1.success || !r2.success) throw new Error("expected answers");
    // 10 input tokens over weights [2, 1]: 7 and 3 (floor 6 + remainder 1, then 3).
    expect(r1.value.usage.inputTokens).toBe(7);
    expect(r2.value.usage.inputTokens).toBe(3);
    expect(r1.value.cost?.totalCost).toBeCloseTo(0.001 * (2 / 3));
    expect(r2.value.cost?.totalCost).toBeCloseTo(0.001 * (1 / 3));
  });

  it("puts different states, and different models, in different requests of one round", async () => {
    const calls: any[] = [];
    const h = hooks();
    const collector = new DecisionCollector(["a", "b", "c"], sender(calls), h);
    await Promise.all([
      collector.submit("a", request()),
      collector.submit("b", request({ state: [{ role: "user", content: "other" }] })),
      collector.submit("c", request({ config: { model: "my-laya", provider: "typesafe" } })),
    ]);
    expect(calls).toHaveLength(3);
    // The round's end callback runs a microtask after the calls resolve.
    await tick();
    expect(h.ended).toBe(1);
  });

  it("fires a group early at the cap and warns", async () => {
    const calls: any[] = [];
    const h = hooks();
    const collector = new DecisionCollector(["a", "b", "c"], sender(calls), h);
    const first = collector.submit("a", request({ questionCap: 2 }));
    const second = collector.submit("b", request({ questionCap: 2 }));
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(h.caps).toBe(1);
    // Arm c has not settled, so the round fired for the cap, not quiescence.
  });

  it("starts a new group when a call would overflow the cap", async () => {
    const calls: any[] = [];
    const h = hooks();
    const collector = new DecisionCollector(["a", "b"], sender(calls), h);
    const two = {
      x: { type: "noul" as const, instructions: "?" },
      y: { type: "noul" as const, instructions: "?" },
    };
    const first = collector.submit("a", request({ questions: two, questionCap: 3 }));
    const second = collector.submit("b", request({ questions: two, questionCap: 3 }));
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].questions)).toHaveLength(2);
    expect(Object.keys(calls[1].questions)).toHaveLength(2);
    expect(h.caps).toBe(1);
  });

  it("delivers a failed request, with its status, to every call in the group", async () => {
    const send = vi.fn(async () => ({
      ...failure("Decision request failed with status 500: no"),
      status: 500,
    }));
    const collector = new DecisionCollector(["a", "b"], send, hooks());
    const [r1, r2] = await Promise.all([
      collector.submit("a", request()),
      collector.submit("b", request()),
    ]);
    expect(r1).toMatchObject({ success: false, status: 500 });
    expect(r2).toMatchObject({ success: false, status: 500 });
  });

  it("drops an aborted call and still fires for the rest", async () => {
    const calls: any[] = [];
    const collector = new DecisionCollector(["a", "b"], sender(calls), hooks());
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const aborted = collector.submit("a", request({ signal: controller.signal }));
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    const other = await collector.submit("b", request());
    expect(other.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual([questionKey(2, "answer")]);
  });

  it("rejects a call that aborts while its request is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const collector = new DecisionCollector(["a"], send as any, hooks());
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const pending = collector.submit("a", request({ signal: controller.signal }));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    release(success({ answers: {}, usage: { inputTokens: 1, outputTokens: 0 }, model: "m" }));
  });

  it("delivers a failure to every call when the sender throws, so no arm hangs", async () => {
    const send = vi.fn(async () => {
      throw new Error("socket exploded");
    });
    const collector = new DecisionCollector(["a", "b"], send as any, hooks());
    const [r1, r2] = await Promise.all([
      collector.submit("a", request()),
      collector.submit("b", request()),
    ]);
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
    if (!r1.success) expect(r1.error).toContain("socket exploded");
  }, 2000);

  it("lets an arm submit again after its first answer, in a later round", async () => {
    const calls: any[] = [];
    const collector = new DecisionCollector(["a", "b"], sender(calls), hooks());
    const first = await Promise.all([
      collector.submit("a", request()),
      collector.submit("b", request()),
    ]);
    expect(first.every((r) => r.success)).toBe(true);
    collector.armSettled("b");
    const again = await collector.submit("a", request());
    expect(again.success).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("splitCounts", () => {
  it("gives the remainder to the first weight", () => {
    expect(splitCounts(10, [2, 1])).toEqual([7, 3]);
    expect(splitCounts(0, [1, 1])).toEqual([0, 0]);
    expect(splitCounts(5, [1])).toEqual([5]);
  });
});
