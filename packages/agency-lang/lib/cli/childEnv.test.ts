import { describe, expect, test } from "vitest";
import { withRootCarriers } from "./childEnv.js";

describe("withRootCarriers", () => {
  test("clears every inherited carrier, then sets only what this invocation resolved", () => {
    const inherited = {
      AGENCY_RUN_POLICY: "stale",
      AGENCY_RUN_POLICY_INTERACTIVE: "1",
      AGENCY_MAX_COST: "9",
      AGENCY_MAX_TIME: "9",
      PATH: "/bin",
    };
    expect(withRootCarriers(inherited, {})).toEqual({ PATH: "/bin" });
    expect(
      withRootCarriers(inherited, {
        policy: { policyJson: "{}", interactive: true },
        budget: { maxCost: "5" },
      }),
    ).toEqual({
      PATH: "/bin",
      AGENCY_RUN_POLICY: "{}",
      AGENCY_RUN_POLICY_INTERACTIVE: "1",
      AGENCY_MAX_COST: "5",
    });
  });
});
