import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import * as smoltalk from "smoltalk";
import {
  isDecisionCall,
  dispatchDecision,
  stateMessages,
  questionCapFor,
} from "./decisionDispatch.js";
import { agencyStore } from "./asyncContext.js";
import { DecisionCollector, DEFAULT_QUESTION_CAP } from "./decisionCollector.js";
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

  it("is true for a registry decision model even when the default provider was baked in", () => {
    // The compiler bakes the config default provider onto every call that
    // named only a model; the registry name still wins.
    expect(isDecisionCall(base({ model: "jev-1.13", provider: "openai-responses" }))).toBe(true);
  });

  it("is false for a registry text model, whatever provider is on the call", () => {
    expect(isDecisionCall(base({ model: "gpt-4o-mini" }))).toBe(false);
    expect(isDecisionCall(base({ model: "gpt-4o-mini", provider: "openai-responses" }))).toBe(
      false,
    );
    // A default provider of typesafe must not capture a stdlib text call.
    expect(isDecisionCall(base({ model: "gpt-4o-mini", provider: "typesafe" }))).toBe(false);
  });

  it("is false for an unknown model with no provider, and for no model at all", () => {
    expect(isDecisionCall(base({ model: "nobody-knows-me" }))).toBe(false);
    expect(isDecisionCall(base({}))).toBe(false);
  });
});

describe("stateMessages", () => {
  it("is the thread before the prompt", () => {
    const messages = [smoltalk.userMessage("ticket"), smoltalk.userMessage("Which department?")];
    expect(stateMessages(messages)).toEqual([messages[0]]);
  });

  it("is the prompt itself when the thread holds nothing else", () => {
    const messages = [smoltalk.userMessage("Which department?")];
    expect(stateMessages(messages)).toEqual(messages);
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

  it("carries the failure's HTTP status onto the thrown error", async () => {
    const decide = vi.fn(async () => ({
      success: false as const,
      error: "Decision request failed: rate limited",
      status: 429,
    }));
    await expect(
      dispatchDecision(ctxWith(decide), base({ model: "jev-1.13" })),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("throws a plain error when the failure has no status", async () => {
    const decide = vi.fn(async () => ({
      success: false as const,
      error: "Decision request failed: socket hang up",
    }));
    const err = await dispatchDecision(ctxWith(decide), base({ model: "jev-1.13" })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect("status" in err).toBe(false);
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

describe("dispatchDecision inside a block", () => {
  it("submits to the frame's collector instead of the client", async () => {
    const decide = vi.fn(); // must never be called directly
    const sent: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
    const collector = new DecisionCollector(
      ["arm"],
      async (state, questions) => {
        sent.push({ state, questions });
        return {
          success: true as const,
          value: {
            answers: {
              c1_answer: {
                type: "choice" as const,
                choice: "billing",
                confidence: 1,
                probabilities: { billing: 1 },
              },
            },
            usage: { inputTokens: 4, outputTokens: 0 },
            model: "jev-1.13",
          },
        };
      },
      { batchStarted: () => () => {}, capReached: () => {} },
    );
    const ctx = ctxWith(decide);
    const frame = {
      ctx,
      stack: {} as any,
      threads: {} as any,
      globals: {} as any,
      decisions: { collector, armKey: "arm" },
    };
    const completion = await agencyStore.run(frame as any, () =>
      dispatchDecision(ctx, base({ model: "jev-1.13" })),
    );
    expect(decide).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0].questions)).toEqual(["c1_answer"]);
    expect(JSON.parse(completion.output!)).toEqual({ response: "billing" });
  });

  it("sends directly when the frame has no collector", async () => {
    const decide = okDecide(); // the file's existing helper
    const ctx = ctxWith(decide);
    const frame = { ctx, stack: {} as any, threads: {} as any, globals: {} as any };
    await agencyStore.run(frame as any, () => dispatchDecision(ctx, base({ model: "jev-1.13" })));
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

describe("questionCapFor", () => {
  it("is the registry cap for a known model and the default otherwise", () => {
    expect(questionCapFor(base({ model: "jev-1.13" }))).toBe(64);
    expect(questionCapFor(base({ model: "my-laya", provider: "typesafe" }))).toBe(
      DEFAULT_QUESTION_CAP,
    );
  });
});
