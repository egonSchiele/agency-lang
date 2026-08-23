import { afterEach, describe, expect, test } from "vitest";
import { clearModelData, registerModelData } from "smoltalk";
import { _hostedSearchTools } from "./llm.js";

afterEach(() => {
  clearModelData();
});

describe("_hostedSearchTools", () => {
  test("model whose provider offers hosted search gets web_search", () => {
    expect(_hostedSearchTools("claude-sonnet-4-6")).toEqual(["web_search"]);
  });

  test("the route decides: gpt-4o-mini via openai-responses has search, via base openai none", () => {
    expect(_hostedSearchTools("gpt-4o-mini", "openai-responses")).toEqual(["web_search"]);
    expect(_hostedSearchTools("gpt-4o-mini", "openai")).toEqual([]);
  });

  test("no provider anywhere means the catalog route, which for gpt-4o-mini is base openai", () => {
    expect(_hostedSearchTools("gpt-4o-mini")).toEqual([]);
  });

  test("google models match even though the catalog names the tool google_search", () => {
    expect(_hostedSearchTools("gemini-2.5-flash")).toEqual(["web_search"]);
  });

  test("unknown model fails open: withholding search is the invisible failure", () => {
    expect(_hostedSearchTools("not-a-real-model")).toEqual(["web_search"]);
  });

  test("empty model with no default anywhere keeps the historical request", () => {
    expect(_hostedSearchTools("")).toEqual(["web_search"]);
  });

  test("known model whose provider has no hosted search gets nothing", () => {
    registerModelData({
      models: [
        {
          type: "text",
          modelName: "llama-local-test",
          provider: "ollama",
          inputTokenCost: 0,
          outputTokenCost: 0,
        },
      ],
      hostedTools: [],
    } as never);
    expect(_hostedSearchTools("llama-local-test")).toEqual([]);
  });
});
