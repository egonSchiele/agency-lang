import { describe, expect, it } from "vitest";
import { checkPolicyExplicit, type Policy, type PolicyDirs } from "../../runtime/policy.js";
import { withPauseLeftAlone } from "./policy.js";

const PIN = [{ action: "propagate" }];
const DIRS: PolicyDirs = {
  cwd: "/work",
  agentHome: "/home/me/.agency-agent",
  home: "/home/me",
  agencyInstallDir: null,
};

function raise(effect: string) {
  return { effect, message: "", data: {}, origin: "test" };
}

describe("withPauseLeftAlone", () => {
  it("pins the core's pause to propagate and keeps the other rules", () => {
    const policy: Policy = { "std::read": [{ action: "approve" }] };
    expect(withPauseLeftAlone(policy)).toEqual({
      "std::read": [{ action: "approve" }],
      "agent::sessionInput": PIN,
    });
  });

  it("replaces a rule the policy had for the pause", () => {
    const policy: Policy = { "agent::sessionInput": [{ action: "approve" }] };
    expect(withPauseLeftAlone(policy)["agent::sessionInput"]).toEqual(PIN);
  });

  it("does not change the policy it is given", () => {
    const policy: Policy = { "*": [{ action: "reject" }] };
    withPauseLeftAlone(policy);
    expect(policy).toEqual({ "*": [{ action: "reject" }] });
  });

  it("beats a `*` rule for the pause, and leaves `*` for the rest", () => {
    const pinned = withPauseLeftAlone({ "*": [{ action: "reject" }] });
    expect(checkPolicyExplicit(pinned, raise("agent::sessionInput"), DIRS)).toEqual({
      type: "propagate",
    });
    expect(checkPolicyExplicit(pinned, raise("std::bash"), DIRS)).toEqual({ type: "reject" });
  });

  // The run's policy handler says nothing about an effect no rule matches,
  // so a run given just the pin is asked about what a run with no policy is.
  it("alone decides nothing but the pause", () => {
    const pinOnly = withPauseLeftAlone({});
    expect(checkPolicyExplicit(pinOnly, raise("std::bash"), DIRS)).toBeNull();
    expect(checkPolicyExplicit(pinOnly, raise("std::read"), DIRS)).toBeNull();
  });
});
