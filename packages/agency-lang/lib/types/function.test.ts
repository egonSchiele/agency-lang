import { describe, it, expect } from "vitest";
import { VALID_CALLBACK_NAMES } from "./function.js";

describe("VALID_CALLBACK_NAMES", () => {
  it("includes the LLM resilience hooks so the runtime accepts them", () => {
    // lib/stdlib/agency.ts validates callback("...") names against this list at
    // runtime; a name not here throws "Unknown callback". hooks.ts also has a
    // compile-time guard keeping this list in sync with CallbackMap.
    expect(VALID_CALLBACK_NAMES).toContain("onLLMRetry");
    expect(VALID_CALLBACK_NAMES).toContain("onLLMTimeout");
  });
});
