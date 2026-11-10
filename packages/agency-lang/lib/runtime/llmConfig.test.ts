import { describe, it, expect } from "vitest";
import { mergeLlmConfig } from "./llmConfig.js";

// A program's defaults almost always name a provider, so these start from
// one, the way a real run does.
const anthropicDefaults = { model: "claude-sonnet-4-5", provider: "anthropic" };

describe("mergeLlmConfig with decision: true", () => {
  it("switches to the provider of the model's decision entry when the first entry is text", () => {
    const merged = mergeLlmConfig(anthropicDefaults, { model: "gpt-6-luna", decision: true });
    expect(merged.provider).toBe("openai");
  });

  it("takes the first decision entry in catalog order when several providers list the name", () => {
    const merged = mergeLlmConfig(anthropicDefaults, { model: "jev-1.14", decision: true });
    expect(merged.provider).toBe("typesafe");
  });

  it("keeps the default provider for a model with no decision entry", () => {
    const merged = mergeLlmConfig(anthropicDefaults, { model: "new-decider", decision: true });
    expect(merged.provider).toBe("anthropic");
  });

  it("keeps an explicit provider", () => {
    const merged = mergeLlmConfig(anthropicDefaults, {
      model: "jev-1.14",
      provider: "openrouter",
      decision: true,
    });
    expect(merged.provider).toBe("openrouter");
  });

  it("keeps the default provider when the call names the default model", () => {
    const merged = mergeLlmConfig(anthropicDefaults, {
      model: "claude-sonnet-4-5",
      decision: true,
    });
    expect(merged.provider).toBe("anthropic");
  });
});

describe("mergeLlmConfig without the option", () => {
  it("leaves a model with a text entry first on the default provider", () => {
    expect(mergeLlmConfig(anthropicDefaults, { model: "gpt-6-luna" }).provider).toBe("anthropic");
  });
});
