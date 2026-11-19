import { describe, expect, it } from "vitest";
import {
  minimalAutoApprovePolicy,
  recommendedAutoApprovePolicy,
} from "../../runtime/builtinPolicies.js";
import { checkPolicyExplicit, type Policy, type PolicyDirs } from "../../runtime/policy.js";
import { sessionRunPolicy, withPauseLeftAlone } from "./policy.js";

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

describe("sessionRunPolicy", () => {
  // Every handler is consulted, and a policy with no rule for an effect
  // says nothing. Beside `recommended`, `minimal`'s silence on reads would
  // let `recommended` approve them. So the session's policy replaces it.
  it("runs a session that carries a policy under it alone", () => {
    const policy = sessionRunPolicy({
      carried: minimalAutoApprovePolicy,
      saved: recommendedAutoApprovePolicy,
      extra: null,
    });
    expect(policy).toEqual(minimalAutoApprovePolicy);
    expect(policy["std::read"]).toBeUndefined();
    expect(checkPolicyExplicit(policy, raise("std::read"), DIRS)).toBeNull();
  });

  it("is the saved policy when the session carries none", () => {
    const saved: Policy = { "std::read": [{ action: "approve" }] };
    expect(sessionRunPolicy({ carried: null, saved, extra: null })).toEqual(saved);
  });

  it("puts the front-end's extra rules ahead of the session's own", () => {
    const policy = sessionRunPolicy({
      carried: { "std::bash": [{ action: "reject" }] },
      saved: {},
      extra: { "std::bash": [{ action: "approve" }] },
    });
    expect(policy["std::bash"]).toEqual([{ action: "approve" }, { action: "reject" }]);
    expect(checkPolicyExplicit(policy, raise("std::bash"), DIRS)).toEqual({ type: "approve" });
  });

  it("layers extra rules over the saved policy when the session carries none", () => {
    const policy = sessionRunPolicy({
      carried: null,
      saved: { "std::read": [{ action: "reject" }] },
      extra: { "std::read": [{ action: "approve" }], "std::ls": [{ action: "approve" }] },
    });
    expect({ ...policy }).toEqual({
      "std::read": [{ action: "approve" }, { action: "reject" }],
      "std::ls": [{ action: "approve" }],
    });
  });

  it("does not change the policies it is given", () => {
    const carried: Policy = { "std::bash": [{ action: "reject" }] };
    const extra: Policy = { "std::bash": [{ action: "approve" }] };
    sessionRunPolicy({ carried, saved: {}, extra });
    expect(carried).toEqual({ "std::bash": [{ action: "reject" }] });
    expect(extra).toEqual({ "std::bash": [{ action: "approve" }] });
  });
});
