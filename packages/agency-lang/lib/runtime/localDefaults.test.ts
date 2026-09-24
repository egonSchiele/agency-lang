import { describe, it, expect } from "vitest";
import { withLocalDefaults, mlxThinkingAttributes } from "./localDefaults.js";

describe("withLocalDefaults", () => {
  it("gives a local model the hosted temperature when the call names none", () => {
    expect(withLocalDefaults({ provider: "mlx", model: "m" })).toEqual({
      provider: "mlx",
      model: "m",
      temperature: 1.0,
    });
    expect(withLocalDefaults({ provider: "llama-cpp", model: "m" }).temperature).toBe(1.0);
  });

  it("keeps a temperature the call names", () => {
    expect(withLocalDefaults({ provider: "mlx", temperature: 0 }).temperature).toBe(0);
  });

  it("leaves a hosted provider's config alone", () => {
    const config = { provider: "anthropic", model: "m", thinking: { enabled: false } };
    expect(withLocalDefaults(config)).toBe(config);
    expect(withLocalDefaults({ model: "gpt-x" })).toEqual({ model: "gpt-x" });
  });

  it("turns the thinking option into the MLX server's request fields", () => {
    expect(
      withLocalDefaults({ provider: "mlx", thinking: { enabled: false } }).rawAttributes,
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(
      withLocalDefaults({ provider: "mlx", thinking: { enabled: true, budgetTokens: 2048 } })
        .rawAttributes,
    ).toEqual({ chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 2048 });
  });

  it("turns a reasoning effort into the effort's thinking budget on MLX", () => {
    expect(withLocalDefaults({ provider: "mlx", reasoningEffort: "low" }).rawAttributes).toEqual({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 2048,
    });
    expect(withLocalDefaults({ provider: "mlx", reasoningEffort: "high" }).rawAttributes).toEqual({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 16384,
    });
  });

  it("lets an explicit budget win over an effort, and thinking off win over both", () => {
    expect(
      withLocalDefaults({
        provider: "mlx",
        reasoningEffort: "high",
        thinking: { enabled: true, budgetTokens: 100 },
      }).rawAttributes,
    ).toEqual({ chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 100 });
    expect(
      withLocalDefaults({ provider: "mlx", reasoningEffort: "high", thinking: { enabled: false } })
        .rawAttributes,
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("does not translate thinking for llama.cpp, which reads the option itself", () => {
    expect(
      withLocalDefaults({ provider: "llama-cpp", thinking: { enabled: false } }).rawAttributes,
    ).toBeUndefined();
  });
});

describe("mlxThinkingAttributes", () => {
  it("keeps other raw attributes and template arguments", () => {
    expect(
      mlxThinkingAttributes(
        { enabled: false },
        { top_k: 5, chat_template_kwargs: { add_generation_prompt: true } },
      ),
    ).toEqual({
      top_k: 5,
      chat_template_kwargs: { add_generation_prompt: true, enable_thinking: false },
    });
  });
});
