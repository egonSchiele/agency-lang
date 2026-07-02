import { describe, it, expect, vi } from "vitest";
import { _setLlmOptions, _listHostedModels, _hostedModelInfo, _modelSupportsInput } from "./llm.js";
import { agencyStore } from "../runtime/asyncContext.js";

// Deterministic smoltalk catalog so the shim's mapping/filtering is tested
// against a small fixture, not smoltalk's baked (external, version-churning)
// data. The real-catalog wiring is covered separately (name-agnostically) in
// llm.hostedCatalog.integration.test.ts.
const { FIXTURE_MODELS } = vi.hoisted(() => ({
  FIXTURE_MODELS: [
    { type: "text", modelName: "fixture-text", provider: "openai", openWeights: false, inputTokenCost: 0.15, outputTokenCost: 0.6, maxInputTokens: 128000, family: "gpt-mini" },
    // A text model with every optional field absent → exercises the ?? defaults.
    { type: "text", modelName: "fixture-bare" },
    { type: "embeddings", modelName: "fixture-embed", provider: "openai" },
  ],
}));
vi.mock("smoltalk", () => ({
  getAllModels: () => FIXTURE_MODELS,
  getModel: (name: string) => FIXTURE_MODELS.find((model) => model.modelName === name),
  refreshModels: vi.fn(),
  registerModelData: vi.fn(),
  // Fixture modality data. Deliberately answers for ANY modality string so
  // the bridge's image/pdf safelist is what the safelist test exercises —
  // if the safelist were removed, "audio" would return true, not null.
  modelSupportsInputModality: (name: string, _modality: string) => {
    if (name === "fixture-vision") {
      return true;
    }
    if (name === "fixture-text") {
      return false;
    }
    return undefined;
  },
}));

// _setLlmOptions writes the ACTIVE stack's `other.llmDefaults`. A bare
// `{ other: {} }` stand-in stack is enough to exercise the merge.
function withStack<T>(stack: any, fn: () => T): T {
  return agencyStore.run({ stack } as any, fn);
}

describe("_setLlmOptions", () => {
  it("writes model into stack.other.llmDefaults", () => {
    const stack = { other: {} as any };
    withStack(stack, () => _setLlmOptions({ model: "gpt-5.5" }));
    expect(stack.other.llmDefaults.model).toBe("gpt-5.5");
  });

  it("merges multiple fields and leaves existing ones intact", () => {
    const stack = { other: { llmDefaults: { model: "old", temperature: 0.1 } } as any };
    withStack(stack, () =>
      _setLlmOptions({ model: "m2", reasoningEffort: "high", maxTokens: 42 }),
    );
    expect(stack.other.llmDefaults).toEqual({
      model: "m2",
      temperature: 0.1,
      reasoningEffort: "high",
      maxTokens: 42,
    });
  });

  it("carries maxToolResultChars in the same bag", () => {
    const stack = { other: {} as any };
    withStack(stack, () => _setLlmOptions({ maxToolResultChars: 5 }));
    expect(stack.other.llmDefaults.maxToolResultChars).toBe(5);
  });

  it("ignores undefined fields (no overwrite with undefined)", () => {
    const stack = { other: { llmDefaults: { model: "keep" } } as any };
    withStack(stack, () => _setLlmOptions({ temperature: 0.5 }));
    expect(stack.other.llmDefaults.model).toBe("keep");
    expect(stack.other.llmDefaults.temperature).toBe(0.5);
  });
});

describe("hosted catalog accessor (over a fixture)", () => {
  it("maps every field incl. family, and applies ?? defaults for absent ones", () => {
    const all = _listHostedModels();
    expect(all.find((model) => model.name === "fixture-text")).toEqual({
      name: "fixture-text",
      provider: "openai",
      openWeights: false,
      inputCost: 0.15,
      outputCost: 0.6,
      contextWindow: 128000,
      family: "gpt-mini",
    });
    // A text model missing every optional field falls back to sane defaults —
    // guards the `?? ""` / `?? 0` / `?? false` mapping.
    expect(all.find((model) => model.name === "fixture-bare")).toEqual({
      name: "fixture-bare",
      provider: "",
      openWeights: false,
      inputCost: 0,
      outputCost: 0,
      contextWindow: 0,
      family: "",
    });
  });
  it("excludes non-text models", () => {
    // fixture-embed (embeddings) must not appear; if the `type === "text"`
    // filter regressed it would leak in here.
    expect(_listHostedModels().map((model) => model.name)).toEqual(["fixture-text", "fixture-bare"]);
  });
  it("_hostedModelInfo returns a text model, or null for unknown/non-text", () => {
    expect(_hostedModelInfo("fixture-text")?.provider).toBe("openai");
    expect(_hostedModelInfo("no-such-model")).toBeNull();
    // Non-text name → null (the `&& model.type === "text"` guard). Drop the
    // guard and this returns a malformed HostedModelInfo instead of null:
    expect(_hostedModelInfo("fixture-embed")).toBeNull();
  });
});

describe("_modelSupportsInput", () => {
  // Real-catalog values (gpt-4o image/pdf true, gpt-3.5-turbo image/pdf
  // false) are pinned by the agent modalityFilter execution tests, which go
  // through the unmocked catalog; here the smoltalk mock isolates the
  // bridge's safelist + null-coercion semantics.
  it("passes through true for a vision model", () => {
    expect(_modelSupportsInput("fixture-vision", "image")).toBe(true);
  });

  it("passes through false for a text-only model", () => {
    expect(_modelSupportsInput("fixture-text", "image")).toBe(false);
  });

  it("passes the pdf modality through", () => {
    expect(_modelSupportsInput("fixture-vision", "pdf")).toBe(true);
    expect(_modelSupportsInput("fixture-text", "pdf")).toBe(false);
  });

  it("returns null for an unknown model", () => {
    expect(_modelSupportsInput("no-such-model-xyz", "image")).toBe(null);
  });

  it("returns null for a modality outside the image/pdf safelist", () => {
    // The mock would answer true for fixture-vision with ANY modality, so
    // this only passes if the bridge's safelist short-circuits first.
    expect(_modelSupportsInput("fixture-vision", "audio")).toBe(null);
  });
});
