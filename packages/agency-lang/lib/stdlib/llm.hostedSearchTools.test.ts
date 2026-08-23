import { afterEach, describe, expect, test } from "vitest";
import { clearModelData, registerModelData } from "smoltalk";

import { agencyStore, type AgencyStore } from "../runtime/asyncContext.js";

import { _hostedSearchTools } from "./llm.js";

/** Run `fn` inside a fake execution frame whose baked smoltalk defaults are
 *  this ambient model/provider pair, the way agency.json bakes one. */
function withAmbient<T>(ambient: { model?: string; provider?: string }, fn: () => T): T {
  const store = {
    ctx: { smoltalkDefaults: ambient },
    stack: { other: {} },
  } as unknown as AgencyStore;
  return agencyStore.run(store, fn);
}

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

  test("a named model never inherits the ambient provider: its catalog route decides", () => {
    // The real call drops the ambient pair the moment a model is named
    // (llmOptions emits provider "" with the model; smoltalk resolves it
    // from the catalog). Gemini via its own provider has search, even
    // though checking it against the ambient openai-responses would say no.
    const ambient = { model: "gpt-4o-mini", provider: "openai-responses" };
    expect(withAmbient(ambient, () => _hostedSearchTools("gemini-2.5-flash"))).toEqual([
      "web_search",
    ]);
    // And a named provider still beats the catalog.
    expect(withAmbient(ambient, () => _hostedSearchTools("gpt-4o-mini", "openai"))).toEqual([]);
  });

  test("no model override: the ambient pair is the route", () => {
    expect(
      withAmbient({ model: "gpt-4o-mini", provider: "openai-responses" }, () =>
        _hostedSearchTools(""),
      ),
    ).toEqual(["web_search"]);
    expect(
      withAmbient({ model: "gpt-4o-mini", provider: "openai" }, () => _hostedSearchTools("")),
    ).toEqual([]);
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
