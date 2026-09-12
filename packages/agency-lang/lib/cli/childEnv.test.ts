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

  test("clears stale resume carriers and sets both only for resume", () => {
    const inherited = {
      AGENCY_RESUME_FILE: "/stale/checkpoint.json",
      AGENCY_RESUME_OVERRIDES: '{"locals":{"stale":true}}',
      PATH: "/bin",
    };

    expect(withRootCarriers(inherited, {})).toEqual({ PATH: "/bin" });
    expect(
      withRootCarriers(inherited, {
        resume: { checkpointFile: "/new/checkpoint.json", overridesJson: "{}" },
      }),
    ).toEqual({
      PATH: "/bin",
      AGENCY_RESUME_FILE: "/new/checkpoint.json",
      AGENCY_RESUME_OVERRIDES: "{}",
    });
  });
});
