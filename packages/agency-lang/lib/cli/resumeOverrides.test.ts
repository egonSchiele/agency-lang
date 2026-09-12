import { describe, expect, it } from "vitest";
import { parseResumeOverrides } from "./resumeOverrides.js";

describe("parseResumeOverrides", () => {
  it("parses JSON values and falls back to strings", () => {
    const result = parseResumeOverrides({
      localVar: ["count=2", "label=hello"],
      arg: ["enabled=true"],
      globalVar: ['config={"mode":"safe"}'],
    });

    expect(result).toEqual({
      locals: { count: 2, label: "hello" },
      args: { enabled: true },
      globals: { config: { mode: "safe" } },
    });
    expect(Object.getPrototypeOf(result.locals!)).toBeNull();
  });

  it("keeps equals signs after the first one", () => {
    expect(parseResumeOverrides({ localVar: ["url=a=b"] }).locals).toEqual({ url: "a=b" });
  });

  it("rejects malformed assignments", () => {
    expect(() => parseResumeOverrides({ arg: ["missing"] })).toThrow("--arg expects name=value");
    expect(() => parseResumeOverrides({ globalVar: ["=value"] })).toThrow(
      "--global-var expects name=value",
    );
    expect(() => parseResumeOverrides({ localVar: ["__proto__=polluted"] })).toThrow(
      "invalid Agency variable name",
    );
  });
});
