import { describe, it, expect } from "vitest";
import { compileChoice, invocationFromRunFlags } from "./debugFlags.js";

describe("compileChoice", () => {
  it("compiles under --agency-only even when agency.json sets distDir", () => {
    expect(compileChoice({ agencyOnly: true, configDistDir: "dist" })).toEqual({
      mode: "agency-only",
    });
  });

  it("refuses --agency-only with --dist-dir", () => {
    expect(compileChoice({ agencyOnly: true, distDir: "dist" })).toEqual({
      refused: "--agency-only compiles the program itself; drop --dist-dir.",
    });
  });

  it("imports from the flag, else the config, else compiles", () => {
    expect(compileChoice({ distDir: "a", configDistDir: "b" })).toEqual({
      mode: "dist-dir",
      distDir: "a",
    });
    expect(compileChoice({ configDistDir: "b" })).toEqual({ mode: "dist-dir", distDir: "b" });
    expect(compileChoice({})).toEqual({ mode: "compile" });
  });
});

describe("invocationFromRunFlags", () => {
  it("is empty when no run flag was given", () => {
    expect(invocationFromRunFlags({}, process.cwd())).toEqual({});
  });

  it("carries the policy the flags describe", () => {
    const invocation = invocationFromRunFlags(
      { approve: "std::read", reject: "std::write" },
      process.cwd(),
    );
    expect(invocation.policy).toMatchObject({
      "std::read": [{ action: "approve" }],
      "std::write": [{ action: "reject" }],
    });
  });

  it("carries the budget in the config's shape", () => {
    expect(invocationFromRunFlags({ maxCost: "0.5", maxTime: "2m" }, process.cwd())).toEqual({
      config: { budget: { maxCost: 0.5, maxTime: "2m" } },
    });
  });

  it("refuses a budget it cannot read", () => {
    expect(() => invocationFromRunFlags({ maxCost: "lots" }, process.cwd())).toThrow("--max-cost");
    expect(() => invocationFromRunFlags({ maxTime: "soon" }, process.cwd())).toThrow("--max-time");
  });
});
