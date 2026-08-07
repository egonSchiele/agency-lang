import { describe, expect, it, vi } from "vitest";

vi.mock("./runBundledAgent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runBundledAgent.js")>();
  return { ...actual, runBundledAgent: vi.fn() };
});

import { agent } from "./agent.js";
import { runBundledAgent } from "./runBundledAgent.js";

describe("agent wrapper forwarding contract", () => {
  it("forwards config, name, THE SAME argv object, and the launch options", () => {
    const config = {};
    const forwarded = ["-p", "hi"];
    agent(config, forwarded, { explicitConfigPath: "root.json" });

    expect(runBundledAgent).toHaveBeenCalledTimes(1);
    expect(runBundledAgent).toHaveBeenCalledWith(
      config,
      "agency-agent",
      forwarded,
      { explicitConfigPath: "root.json" },
    );
    // Identity, not just deep equality: the wrapper must preserve the argv
    // object so the launcher's "child receives the original argv" contract
    // holds end to end.
    expect(vi.mocked(runBundledAgent).mock.calls[0][2]).toBe(forwarded);
  });
});
