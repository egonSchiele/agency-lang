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
