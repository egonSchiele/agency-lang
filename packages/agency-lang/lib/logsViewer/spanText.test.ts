import { describe, expect, it } from "vitest";
import { toolArgSummary } from "./spanText.js";
describe("toolArgSummary", () => {
  it("prefers the subject and falls back to text, JSON, or empty", () => {
    expect(toolArgSummary({ useAgentCwd: "no", filename: "handlers.md" })).toBe("handlers.md");
    expect(toolArgSummary({ other: "value" })).toBe("value");
    expect(toolArgSummary({ count: 3 })).toBe('{"count":3}');
    expect(toolArgSummary(undefined)).toBe("");
  });
});
