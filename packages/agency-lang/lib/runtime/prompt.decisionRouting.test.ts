import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { SmolConfig } from "smoltalk";
import { agency } from "./agency.js";
import { DeterministicClient } from "./deterministicClient.js";
import type { DecideConfig, DecisionQuestion, DecisionState } from "./llmClient.js";
import { runPrompt } from "./prompt.js";
import { RuntimeContext } from "./state/context.js";
import { ThreadStore } from "./state/threadStore.js";
import { _setLlmOptions, type LlmDefaults } from "../stdlib/llm.js";

class RecordingDecisionClient extends DeterministicClient {
  configs: DecideConfig[] = [];

  async decide(
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    config: DecideConfig,
    signal: AbortSignal,
  ) {
    this.configs.push(config);
    return super.decide(state, questions, config, signal);
  }
}

describe("runPrompt decision provider selection", () => {
  it.each([
    [
      "custom decision model from model data",
      {
        model: "gpt-4o-mini",
        provider: "openai",
        modelData: {
          schemaVersion: 1,
          generatedAt: "2026-09-26",
          hostedTools: [],
          models: [{ type: "decision", modelName: "custom-decision", provider: "custom-provider" }],
        },
      },
      {},
      { model: "custom-decision" },
      "custom-provider",
    ],
    [
      "successive branch setters",
      { model: "gpt-4o-mini", provider: "openai" },
      [{ model: "gpt-4o-mini", provider: "openai" }, { model: "jev-1.13" }],
      {},
      "typesafe",
    ],
    [
      "repeated branch model",
      { model: "gpt-4o-mini", provider: "openai" },
      [{ model: "jev-1.13", provider: "openrouter" }, { model: "jev-1.13" }],
      {},
      "openrouter",
    ],
    ["run defaults", { model: "jev-1.13", provider: "openrouter" }, {}, {}, "openrouter"],
    [
      "explicit call",
      { model: "gpt-4o-mini", provider: "openai" },
      {},
      { model: "jev-1.13", provider: "openrouter" },
      "openrouter",
    ],
    [
      "model-only call",
      { model: "gpt-4o-mini", provider: "openai" },
      {},
      { model: "jev-1.13" },
      "typesafe",
    ],
    [
      "model-only branch",
      { model: "gpt-4o-mini", provider: "openai" },
      { model: "jev-1.13" },
      {},
      "typesafe",
    ],
    [
      "explicit branch",
      { model: "gpt-4o-mini", provider: "openai" },
      { model: "jev-1.13", provider: "openrouter" },
      {},
      "openrouter",
    ],
    [
      "same-model call",
      { model: "jev-1.13", provider: "openrouter" },
      {},
      { model: "jev-1.13" },
      "openrouter",
    ],
    [
      "same-model call over branch",
      { model: "gpt-4o-mini", provider: "openai" },
      { model: "jev-1.13", provider: "openrouter" },
      { model: "jev-1.13" },
      "openrouter",
    ],
    [
      "different model over branch",
      { model: "jev-1.13", provider: "openrouter" },
      { model: "gpt-4o-mini", provider: "openai" },
      { model: "jev-1.13" },
      "typesafe",
    ],
  ] satisfies Array<
    [string, Partial<SmolConfig>, LlmDefaults | LlmDefaults[], Partial<SmolConfig>, string]
  >)("routes %s to the selected provider", async (_name, defaults, branch, call, provider) => {
    const ctx = new RuntimeContext({
      statelogConfig: {
        host: "https://example.com",
        apiKey: "test",
        projectId: "test",
        debugMode: false,
      },
      smoltalkDefaults: defaults,
      dirname: "/tmp",
    });
    const client = new RecordingDecisionClient([
      { decide: { answer: { type: "noul", noul: 0.9 } } },
    ]);
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const value = await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        for (const options of Array.isArray(branch) ? branch : [branch]) {
          _setLlmOptions(options);
        }
        return runPrompt({
          prompt: "Is this spam?",
          messages: threads.getOrCreateActive(),
          responseFormat: z.object({ response: z.boolean() }),
          clientConfig: call,
        });
      },
    );
    expect(value).toBe(true);
    expect(client.configs).toHaveLength(1);
    expect(client.configs[0].provider).toBe(provider);
  });
});
