import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import * as smoltalk from "smoltalk";

// Count metered attempts without touching the real usage sink.
vi.mock("./recordPaidUsage.js", () => ({
  meteredDispatch: vi.fn((_ctx: unknown, _stack: unknown, _kind: unknown, dispatch: () => Promise<unknown>) => dispatch()),
}));

import { meteredDispatch } from "./recordPaidUsage.js";
import { dispatchWithRetry } from "./llmDispatch.js";
import type { PromptConfig } from "./llmClient.js";
import { DEFAULT_RETRY_POLICY } from "./llmRetry.js";

function ctxWith(client: Record<string, unknown>) {
  return {
    llmClient: client,
    stateStack: {},
    isCancelled: () => false,
  } as any;
}

const dept = z.union([z.literal("billing"), z.literal("support")]);

function config(over: Partial<PromptConfig> & Record<string, unknown>): PromptConfig {
  return {
    messages: [smoltalk.userMessage("Which department?")],
    responseFormat: z.object({ response: dept }),
    model: "jev-1.13",
    ...over,
  } as PromptConfig;
}

beforeEach(() => {
  vi.mocked(meteredDispatch).mockClear();
});

describe("dispatchWithRetry with a decision call", () => {
  it("refuses a call with no schema before any metered attempt", async () => {
    const decide = vi.fn();
    await expect(
      dispatchWithRetry({
        ctx: ctxWith({ decide }),
        promptConfig: config({ responseFormat: undefined }),
        prompt: "Which department?",
        stream: false,
        retryPolicy: { ...DEFAULT_RETRY_POLICY, retries: 0 },
        parentSignal: undefined,
      }),
    ).rejects.toThrow(/type annotation/);
    expect(meteredDispatch).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("refuses a call with tools before any metered attempt", async () => {
    const decide = vi.fn();
    await expect(
      dispatchWithRetry({
        ctx: ctxWith({ decide }),
        promptConfig: config({ tools: [{ name: "t", schema: z.object({}) }] }),
        prompt: "Which department?",
        stream: false,
        retryPolicy: { ...DEFAULT_RETRY_POLICY, retries: 0 },
        parentSignal: undefined,
      }),
    ).rejects.toThrow(/cannot call tools/);
    expect(meteredDispatch).not.toHaveBeenCalled();
  });

  it("meters a sent decision call under the decision kind", async () => {
    const decide = vi.fn(async () => ({
      success: true as const,
      value: {
        answers: {
          answer: { type: "choice", choice: "billing", confidence: 1, probabilities: { billing: 1, support: 0 } },
        },
        usage: { inputTokens: 1, outputTokens: 0 },
        model: "jev-1.13",
      },
    }));
    const { completion } = await dispatchWithRetry({
      ctx: ctxWith({ decide }),
      promptConfig: config({}),
      prompt: "Which department?",
      stream: false,
      retryPolicy: { ...DEFAULT_RETRY_POLICY, retries: 0 },
      parentSignal: undefined,
    });
    expect(JSON.parse(completion.output!)).toEqual({ response: "billing" });
    expect(vi.mocked(meteredDispatch).mock.calls[0][2]).toBe("decision");
  });
});
