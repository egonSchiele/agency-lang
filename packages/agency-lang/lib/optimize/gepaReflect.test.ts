import { describe, expect, it } from "vitest";

import { AgencyRunner } from "./grading/agencyRunner.js";
import { proposeReflective } from "./gepaReflect.js";

describe("proposeReflective", () => {
  it("returns a validated mutation proposal from the reflective agent", async () => {
    const runner = new AgencyRunner({}, async () => ({
      data: {
        rationale: "tighten the prompt",
        operations: [{ target: "agent.agency:global:prompt", kind: "variable", op: "replaceInitializer", value: "\"Be concise.\"", rationale: "shorter" }],
      },
    }));
    const proposal = await proposeReflective(runner, { targets: "id: prompt", feedback: "[q1] too verbose", history: "" });
    expect(proposal.rationale).toBe("tighten the prompt");
    expect(proposal.operations).toHaveLength(1);
  });

  it("throws on a malformed reflective response", async () => {
    const runner = new AgencyRunner({}, async () => ({ data: { rationale: "" } }));
    await expect(proposeReflective(runner, { targets: "", feedback: "", history: "" })).rejects.toThrow();
  });
});
