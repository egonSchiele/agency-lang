import { describe, it, expect } from "vitest";
import { _setLlmOptions } from "./llm.js";
import { agencyStore } from "../runtime/asyncContext.js";

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

import { _listHostedModels, _hostedModelInfo } from "./llm.js";

describe("hosted catalog accessor", () => {
  it("_listHostedModels maps text models to HostedModelInfo (structural)", () => {
    const all = _listHostedModels();
    expect(all.length).toBeGreaterThan(0);
    const mini = all.find((model) => model.name === "gpt-4o-mini");
    expect(mini).toBeDefined();
    // Stable identity/metadata:
    expect(mini!.provider).toBe("openai");
    expect(mini!.openWeights).toBe(false);
    // `family` must actually be mapped (guards a wrong-source-field bug) —
    // assert presence, not the exact string:
    expect(typeof mini!.family).toBe("string");
    expect(mini!.family.length).toBeGreaterThan(0);
    // Numeric fields mapped + sane — NOT exact, so a smoltalk price bump can't
    // break this:
    expect(mini!.inputCost).toBeGreaterThan(0);
    expect(mini!.outputCost).toBeGreaterThan(0);
    expect(mini!.contextWindow).toBeGreaterThan(0);
  });
  it("_listHostedModels excludes non-text models", () => {
    const all = _listHostedModels();
    // Every text model has a real context window; embeddings/image models map
    // to contextWindow 0. If the `type === "text"` filter regressed, one would
    // leak in with contextWindow 0 and this fails.
    expect(all.every((model) => model.contextWindow > 0)).toBe(true);
    // And a known embeddings model must not appear in the text-only list:
    expect(all.find((model) => model.name === "text-embedding-3-small")).toBeUndefined();
  });
  it("_hostedModelInfo returns one text model, or null for unknown/non-text", () => {
    expect(_hostedModelInfo("gpt-4o-mini")?.provider).toBe("openai");
    expect(_hostedModelInfo("no-such-model-xyz")).toBeNull();
    // Non-text name → null (the `&& model.type === "text"` guard). Drop the
    // guard and this returns a malformed HostedModelInfo instead of null:
    expect(_hostedModelInfo("text-embedding-3-small")).toBeNull();
  });
});
