import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import * as smoltalk from "smoltalk";
import { isDecisionCall, dispatchDecision } from "./decisionDispatch.js";
import type { PromptConfig } from "./llmClient.js";

const dept = z.union([z.literal("billing"), z.literal("support")]);

function base(over: Partial<PromptConfig> & Record<string, unknown>): PromptConfig {
  return {
    messages: [smoltalk.userMessage("Which department?")],
    responseFormat: z.object({ response: dept }),
    ...over,
  } as PromptConfig;
}

const answer = {
  type: "choice" as const,
  choice: "billing",
  confidence: 0.9,
  probabilities: { billing: 0.9, support: 0.1 },
};

function okDecide() {
  return vi.fn(async () => ({
    success: true as const,
    value: {
      answers: { answer },
      usage: { inputTokens: 40, outputTokens: 0 },
      cost: { inputCost: 0.000002, outputCost: 0, totalCost: 0.000002, currency: "USD" },
      model: "jev-1.13-x",
    },
  }));
}

function ctxWith(decide: unknown) {
  return { llmClient: { decide } } as any;
}

describe("isDecisionCall", () => {
  it("is true for an explicit typesafe provider with any model", () => {
    expect(isDecisionCall(base({ model: "my-laya", provider: "typesafe" }))).toBe(true);
  });

  it("is true for a registry decision model with no provider", () => {
    expect(isDecisionCall(base({ model: "jev-1.13" }))).toBe(true);
  });

  it("is true for a registry decision model even when the default provider was filled in", () => {
    // runPrompt fills the config default provider onto every call that
    // named only a model; the registry name still wins.
    expect(isDecisionCall(base({ model: "jev-1.13", provider: "openai-responses" }))).toBe(true);
  });

  it("is false for a text model, with or without a filled-in provider", () => {
    expect(isDecisionCall(base({ model: "gpt-4o-mini" }))).toBe(false);
    expect(isDecisionCall(base({ model: "gpt-4o-mini", provider: "openai-responses" }))).toBe(
      false,
    );
  });

  it("is false for an unknown model with no provider, and for no model at all", () => {
    expect(isDecisionCall(base({ model: "nobody-knows-me" }))).toBe(false);
    expect(isDecisionCall(base({}))).toBe(false);
  });
});

describe("dispatchDecision", () => {
  it("sends the thread as state and the schema as questions", async () => {
    const decide = okDecide();
    const signal = new AbortController().signal;
    await dispatchDecision(
      ctxWith(decide),
      base({
        model: "jev-1.13",
        abortSignal: signal,
        apiKey: { typesafe: "call-key" },
        metadata: {
          apiKey: { typesafe: "meta-key", openAi: "o" },
          baseUrl: { typesafe: "http://localhost:8000" },
        },
      }),
    );
    expect(decide).toHaveBeenCalledTimes(1);
    const [state, questions, config, sig] = decide.mock.calls[0] as unknown as [
      unknown,
      Record<string, { type: string }>,
      Record<string, unknown>,
      AbortSignal,
    ];
    expect(state).toEqual([{ role: "user", content: "Which department?" }]);
    expect(questions.answer.type).toBe("choice");
    // The same key rule a text call uses: the per-call map wins over the
    // config map, one provider slot at a time.
    expect(config).toEqual({
      model: "jev-1.13",
      provider: "typesafe",
      apiKey: { typesafe: "call-key", openAi: "o" },
      baseUrl: { typesafe: "http://localhost:8000" },
      modelData: undefined,
    });
    expect(sig).toBe(signal);
  });

  it("returns a completion with the enveloped JSON value, the usage, the cost, and the raw answers", async () => {
    const completion = await dispatchDecision(ctxWith(okDecide()), base({ model: "jev-1.13" }));
    expect(JSON.parse(completion.output!)).toEqual({ response: "billing" });
    expect(completion.toolCalls).toEqual([]);
    expect(completion.usage).toEqual({ inputTokens: 40, outputTokens: 0 });
    expect(completion.cost?.totalCost).toBe(0.000002);
    expect(completion.model).toBe("jev-1.13-x");
    expect(completion.stopReason).toBe("stop");
    expect((completion.rawData as { answers: Record<string, unknown> }).answers.answer).toEqual(
      answer,
    );
  });

  it("throws before calling the client when there is no schema", async () => {
    const decide = vi.fn();
    await expect(
      dispatchDecision(ctxWith(decide), base({ model: "jev-1.13", responseFormat: undefined })),
    ).rejects.toThrow(/type annotation/);
    expect(decide).not.toHaveBeenCalled();
  });

  it("throws before calling the client when tools are given", async () => {
    const decide = vi.fn();
    await expect(
      dispatchDecision(
        ctxWith(decide),
        base({ model: "jev-1.13", tools: [{ name: "t", schema: z.object({}) }] }),
      ),
    ).rejects.toThrow(/cannot call tools/);
    expect(decide).not.toHaveBeenCalled();
  });

  it("throws when the client has no decide method", async () => {
    await expect(
      dispatchDecision({ llmClient: {} } as any, base({ model: "jev-1.13" })),
    ).rejects.toThrow(/does not support decision models/);
  });

  it("throws the failure message when the client fails", async () => {
    const decide = vi.fn(async () => ({
      success: false as const,
      error: "No TypeSafe API key provided.",
    }));
    await expect(dispatchDecision(ctxWith(decide), base({ model: "jev-1.13" }))).rejects.toThrow(
      /No TypeSafe API key/,
    );
  });

  it("throws an error carrying the HTTP status when the client reports one, so retry can classify it", async () => {
    const decide = vi.fn(async () => ({
      success: false as const,
      error: "Decision request failed with status 429: slow down",
    }));
    const err = await dispatchDecision(ctxWith(decide), base({ model: "jev-1.13" })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/status 429/);
    expect(err.status).toBe(429);
  });

  it("throws when the answers do not fit the schema", async () => {
    const decide = vi.fn(async () => ({
      success: true as const,
      value: {
        answers: { answer: { type: "noul", noul: 0.3 } },
        usage: { inputTokens: 1, outputTokens: 0 },
        model: "m",
      },
    }));
    await expect(dispatchDecision(ctxWith(decide), base({ model: "jev-1.13" }))).rejects.toThrow(
      /answered "answer" as a noul, but a choice was asked/,
    );
  });
});
