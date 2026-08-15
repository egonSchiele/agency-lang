import { describe, expect, it } from "vitest";

import { suiteFromConfig } from "./suite.js";

function config(source: unknown) {
  return {
    provenance: {
      inputsSource: { source },
      files: {},
      agent: { command: "x", harnessVersion: "0" },
    },
  } as never;
}

describe("suiteFromConfig", () => {
  it("local paths use the basename without the data extension", () => {
    expect(suiteFromConfig(config("suites/terminal-bench.json")).suite).toBe("terminal-bench");
    expect(suiteFromConfig(config("inputs.jsonl")).suite).toBe("inputs");
    expect(suiteFromConfig(config("/abs/cases.agency")).suite).toBe("cases");
  });

  it("git sources use the repository basename plus a shortened ref", () => {
    expect(
      suiteFromConfig(config("github.com/foo/terminal-bench.git?ref=abc123def456")).suite,
    ).toBe("terminal-bench@abc123de");
    expect(suiteFromConfig(config("git@github.com:foo/bench.git")).suite).toBe("bench");
    expect(suiteFromConfig(config("https://github.com/foo/bench")).suite).toBe("bench");
  });

  it("inline sources keep a whitespace-normalized prefix", () => {
    expect(suiteFromConfig(config("inline:--goal")).suite).toBe("inline:--goal");
    const long = `inline:${"goal words ".repeat(10)}`;
    const suite = suiteFromConfig(config(long)).suite;
    expect(suite.length).toBeLessThanOrEqual(24);
  });

  it("optimize and unspecified sources pass through / dash", () => {
    expect(suiteFromConfig(config("optimize")).suite).toBe("optimize");
    expect(suiteFromConfig(config("unspecified")).suite).toBe("—");
  });

  it("missing config or malformed provenance is a dash with a warning", () => {
    expect(suiteFromConfig(null).suite).toBe("—");
    const malformed = suiteFromConfig(config(42));
    expect(malformed.suite).toBe("—");
    expect(malformed.warning).toBeDefined();
  });

  it("legacy string config.inputsSource is honored", () => {
    const legacy = { inputsSource: "old-suite.json" } as never;
    expect(suiteFromConfig(legacy).suite).toBe("old-suite");
  });
});
