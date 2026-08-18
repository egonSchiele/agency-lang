import { describe, expect, it } from "vitest";

import { suiteFromSource } from "./suite.js";

describe("suiteFromSource", () => {
  it("local paths use the basename without the data extension", () => {
    expect(suiteFromSource("suites/terminal-bench.json")).toBe("terminal-bench");
    expect(suiteFromSource("inputs.jsonl")).toBe("inputs");
    expect(suiteFromSource("/abs/cases.agency")).toBe("cases");
  });

  it("git sources use the repository basename plus a shortened ref", () => {
    expect(suiteFromSource("github.com/foo/terminal-bench.git?ref=abc123def456")).toBe(
      "terminal-bench@abc123de",
    );
    expect(suiteFromSource("git@github.com:foo/bench.git")).toBe("bench");
    expect(suiteFromSource("https://github.com/foo/bench")).toBe("bench");
  });

  it("inline sources keep a whitespace-normalized prefix", () => {
    expect(suiteFromSource("inline:--goal")).toBe("inline:--goal");
    const long = `inline:${"goal words ".repeat(10)}`;
    expect(suiteFromSource(long).length).toBeLessThanOrEqual(24);
  });

  it("optimize and unspecified sources pass through / dash", () => {
    expect(suiteFromSource("optimize")).toBe("optimize");
    expect(suiteFromSource("unspecified")).toBe("—");
  });

  it("no suite on record is a dash", () => {
    expect(suiteFromSource(null)).toBe("—");
    expect(suiteFromSource(undefined)).toBe("—");
  });
});
