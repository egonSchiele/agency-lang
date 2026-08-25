import { describe, expect, it } from "vitest";

import { AgencyRunner } from "@/eval/grading/agencyRunner.js";
import { proposeReflective } from "./gepaReflect.js";

describe("proposeReflective", () => {
  it("returns a validated mutation proposal from the reflective agent", async () => {
    const runner = new AgencyRunner({}, async () => ({
      data: {
        rationale: "tighten the prompt",
        operations: [
          {
            target: "agent.agency:global:prompt",
            kind: "variable",
            op: "replaceInitializer",
            value: '"Be concise."',
            rationale: "shorter",
          },
        ],
      },
    }));
    const proposal = await proposeReflective(runner, {
      targets: "id: prompt",
      feedback: "[q1] too verbose",
      history: "",
    });
    expect(proposal.rationale).toBe("tighten the prompt");
    expect(proposal.operations).toHaveLength(1);
  });

  it("runs the reflective agent on the mutator model when one is given", async () => {
    let seen: string | undefined;
    const runner = new AgencyRunner({ client: { defaultModel: "gpt-5-mini" } }, async (args) => {
      seen = args.config.client?.defaultModel;
      return {
        data: {
          rationale: "r",
          operations: [
            {
              target: "agent.agency:global:prompt",
              kind: "variable",
              op: "replaceInitializer",
              value: '"x"',
              rationale: "r",
            },
          ],
        },
      };
    });
    await proposeReflective(runner, { targets: "", feedback: "", history: "" }, "gpt-5");
    expect(seen).toBe("gpt-5");
    await proposeReflective(runner, { targets: "", feedback: "", history: "" });
    expect(seen).toBe("gpt-5-mini");
  });

  it("throws on a malformed reflective response", async () => {
    const runner = new AgencyRunner({}, async () => ({ data: { rationale: "" } }));
    await expect(
      proposeReflective(runner, { targets: "", feedback: "", history: "" }),
    ).rejects.toThrow();
  });
});
