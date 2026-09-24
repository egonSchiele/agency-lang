import { describe, it, expect } from "vitest";
import { withLocalDefaults, mlxThinkingAttributes, localProviderOf } from "./localDefaults.js";

describe("localProviderOf", () => {
  it("knows the two local providers by name, and a .gguf path with no provider as llama.cpp", () => {
    expect(localProviderOf({ provider: "mlx" })).toBe("mlx");
    expect(localProviderOf({ provider: "llama-cpp" })).toBe("llama-cpp");
    expect(localProviderOf({ model: "/models/x.gguf" })).toBe("llama-cpp");
    expect(localProviderOf({ model: "/models/x.gguf", provider: "openai" })).toBeUndefined();
    expect(localProviderOf({ model: "gpt-x" })).toBeUndefined();
  });
});

describe("withLocalDefaults", () => {
  it("gives a local model the local temperature when the call names none", () => {
    expect(withLocalDefaults({ provider: "llama-cpp", model: "m" })).toEqual({
      provider: "llama-cpp",
      model: "m",
      temperature: 0.7,
      metadata: undefined,
    });
    expect(withLocalDefaults({ model: "/models/m.gguf" }).temperature).toBe(0.7);
  });

  it("keeps a temperature the call names", () => {
    expect(withLocalDefaults({ provider: "llama-cpp", temperature: 0 }).temperature).toBe(0);
  });

  it("sends the MLX server its sampling in the request body, since the client sends none", () => {
    expect(withLocalDefaults({ provider: "mlx", model: "m" })).toEqual({
      provider: "mlx",
      model: "m",
      temperature: 0.7,
      rawAttributes: { temperature: 0.7, top_p: 0.95 },
    });
    expect(withLocalDefaults({ provider: "mlx", temperature: 0.2 }).rawAttributes).toEqual({
      temperature: 0.2,
      top_p: 0.95,
    });
    expect(
      withLocalDefaults({ provider: "mlx", rawAttributes: { top_p: 0.5, top_k: 20 } })
        .rawAttributes,
    ).toEqual({ top_p: 0.5, top_k: 20, temperature: 0.7 });
  });

  it("leaves a hosted provider's config alone", () => {
    const config = { provider: "anthropic", model: "m", thinking: { enabled: false } };
    expect(withLocalDefaults(config)).toBe(config);
    expect(withLocalDefaults({ model: "gpt-x" })).toEqual({ model: "gpt-x" });
  });

  it("turns the thinking option into the MLX server's request fields", () => {
    expect(
      withLocalDefaults({ provider: "mlx", thinking: { enabled: false } }).rawAttributes,
    ).toEqual({
      temperature: 0.7,
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(
      withLocalDefaults({ provider: "mlx", thinking: { enabled: true, budgetTokens: 2048 } })
        .rawAttributes,
    ).toEqual({
      temperature: 0.7,
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 2048,
    });
  });

  it("turns a reasoning effort into the effort's budget, and tells a Harmony template the effort", () => {
    expect(withLocalDefaults({ provider: "mlx", reasoningEffort: "low" }).rawAttributes).toEqual({
      temperature: 0.7,
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" },
      reasoning_budget: 2048,
    });
    expect(
      withLocalDefaults({ provider: "mlx", reasoningEffort: "high" }).rawAttributes
        ?.reasoning_budget,
    ).toBe(16384);
  });

  it("lets an explicit budget win over an effort, and thinking off win over both", () => {
    expect(
      withLocalDefaults({
        provider: "mlx",
        reasoningEffort: "high",
        thinking: { enabled: true, budgetTokens: 100 },
      }).rawAttributes?.reasoning_budget,
    ).toBe(100);
    expect(
      withLocalDefaults({ provider: "mlx", reasoningEffort: "high", thinking: { enabled: false } })
        .rawAttributes?.chat_template_kwargs,
    ).toEqual({ enable_thinking: false, reasoning_effort: "high" });
  });

  it("does not translate thinking for llama.cpp, which reads the option itself", () => {
    expect(
      withLocalDefaults({ provider: "llama-cpp", thinking: { enabled: false } }).rawAttributes,
    ).toBeUndefined();
  });

  it("runs a drafted llama.cpp model greedy unless the call names a temperature", () => {
    const metadata = { llamaCppDraftModel: "/m/small.gguf" };
    expect(
      withLocalDefaults({ provider: "llama-cpp", model: "/m/big.gguf", metadata }, "/m/big.gguf")
        .temperature,
    ).toBe(0);
    expect(
      withLocalDefaults(
        { provider: "llama-cpp", model: "/m/big.gguf", metadata, temperature: 0.5 },
        "/m/big.gguf",
      ).temperature,
    ).toBe(0.5);
  });

  it("drops a draft model from a call that names another model than the run's", () => {
    const metadata = { llamaCppDraftModel: "/m/small.gguf", llamaCppContextSize: 8192 };
    const forTheRunsModel = withLocalDefaults(
      { provider: "llama-cpp", model: "/m/big.gguf", metadata },
      "/m/big.gguf",
    );
    expect(forTheRunsModel.metadata).toEqual(metadata);
    const forAnother = withLocalDefaults(
      { provider: "llama-cpp", model: "/m/other.gguf", metadata },
      "/m/big.gguf",
    );
    expect(forAnother.metadata).toEqual({ llamaCppContextSize: 8192 });
  });
});

describe("mlxThinkingAttributes", () => {
  it("keeps other raw attributes and template arguments", () => {
    expect(
      mlxThinkingAttributes({ enabled: false }, undefined, {
        top_k: 5,
        chat_template_kwargs: { add_generation_prompt: true },
      }),
    ).toEqual({
      top_k: 5,
      chat_template_kwargs: { add_generation_prompt: true, enable_thinking: false },
    });
  });
});
