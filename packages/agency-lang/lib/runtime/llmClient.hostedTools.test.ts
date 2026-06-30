import { describe, it, expect } from "vitest";
import type { PromptConfig, LLMClient } from "./llmClient.js";
import { toSmolConfig } from "./llmClient.js";

describe("toSmolConfig hostedTools forwarding", () => {
  it("includes hostedTools in the smoltalk config", () => {
    // Pins the contract: hostedTools must survive the config translation.
    const smol = toSmolConfig({
      messages: [],
      model: "gpt-4o-mini",
      hostedTools: ["web_search"],
    } as unknown as PromptConfig);
    expect(smol.hostedTools).toEqual(["web_search"]);
  });

  it("omits hostedTools when not provided", () => {
    const smol = toSmolConfig({
      messages: [],
      model: "gpt-4o-mini",
    } as unknown as PromptConfig);
    expect(smol.hostedTools).toBeUndefined();
  });
});

describe("PromptConfig contract", () => {
  it("makes hostedTools visible to a custom LLMClient via the typed PromptConfig", () => {
    // The actual hole today: PromptConfig does not declare hostedTools, so a
    // custom client (the documented extension point via ctx.llmClient) never
    // sees the field on its typed argument. After Task 1's PromptConfig
    // change, this compiles AND the value is observed at runtime.
    let observed: string[] | undefined;
    const customClient: LLMClient = {
      async text(config: PromptConfig) {
        observed = config.hostedTools;
        return { success: true, value: {} as any };
      },
      async *textStream() {},
      async embed() {
        return { success: false, error: "not supported" };
      },
    };
    void customClient.text({
      messages: [],
      model: "gpt-4o-mini",
      hostedTools: ["web_search"],
    });
    expect(observed).toEqual(["web_search"]);
  });
});
