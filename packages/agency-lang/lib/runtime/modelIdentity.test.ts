import { describe, it, expect } from "vitest";
import { resolveCompletionModel } from "./modelIdentity.js";

describe("resolveCompletionModel", () => {
  it("prefers the provider-reported completion model", () => {
    expect(resolveCompletionModel("opus-4.8", "sonnet")).toBe("opus-4.8");
  });
  it("falls back to the configured model when the completion model is empty/absent", () => {
    expect(resolveCompletionModel(undefined, "sonnet")).toBe("sonnet");
    expect(resolveCompletionModel("", "sonnet")).toBe("sonnet");
    expect(resolveCompletionModel(null, "sonnet")).toBe("sonnet");
  });
  it("returns 'unknown model' when neither is available", () => {
    expect(resolveCompletionModel(undefined, undefined)).toBe("unknown model");
    expect(resolveCompletionModel("", "")).toBe("unknown model");
  });
});
