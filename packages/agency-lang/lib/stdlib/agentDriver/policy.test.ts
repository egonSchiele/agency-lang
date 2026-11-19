import { describe, expect, it } from "vitest";
import {
  minimalAutoApprovePolicy,
  recommendedAutoApprovePolicy,
} from "../../runtime/builtinPolicies.js";
import { checkPolicyExplicit, type Policy, type PolicyDirs } from "../../runtime/policy.js";
import { failure, success, type Result } from "../../types/result.js";
import { rejectRulesOf, sessionRunPolicy, withPauseLeftAlone } from "./policy.js";
import { POLICY_UNREADABLE } from "./sessionPolicy.js";

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
  // Beside `recommended`, `minimal`'s silence on reads would let
  // `recommended` approve them.
  it("does not take the saved policy's approvals into a session with a policy of its own", () => {
    const policy = policyOf(
      sessionRunPolicy({
        carried: success(minimalAutoApprovePolicy),
        saved: recommendedAutoApprovePolicy,
        extra: null,
      }),
    );
    expect({ ...policy }).toEqual(minimalAutoApprovePolicy);
    expect(checkPolicyExplicit(policy, raise("std::read"), DIRS)).toBeNull();
  });

  it("keeps the saved policy's rejects in a session with a policy of its own", () => {
    const saved: Policy = {
      "std::bash": [{ action: "reject" }],
      "std::read": [{ action: "approve" }],
    };
    const policy = policyOf(
      sessionRunPolicy({ carried: success(minimalAutoApprovePolicy), saved, extra: null }),
    );
    expect(checkPolicyExplicit(policy, raise("std::bash"), DIRS)).toEqual({ type: "reject" });
    expect(checkPolicyExplicit(policy, raise("std::read"), DIRS)).toBeNull();
  });

  it("is the saved policy when the session has none of its own", () => {
    const saved: Policy = { "std::read": [{ action: "approve" }] };
    expect(sessionRunPolicy({ carried: success(null), saved, extra: null })).toEqual(
      success(saved),
    );
  });

  // A policy that can't be read is not a session with no policy: run under
  // `saved`, its reads would be approved here.
  it("fails, and never falls back to the saved policy, when the session's policy can't be read", () => {
    const policy = sessionRunPolicy({
      carried: failure(POLICY_UNREADABLE),
      saved: { "std::read": [{ action: "approve" }] },
      extra: { "std::bash": [{ action: "approve" }] },
    });
    expect(policy).toEqual(failure(POLICY_UNREADABLE));
  });

  it("puts the flags given at resume ahead of the session's own rules", () => {
    const policy = policyOf(
      sessionRunPolicy({
        carried: success({ "std::bash": [{ action: "reject" }] }),
        saved: {},
        extra: { "std::bash": [{ action: "approve" }] },
      }),
    );
    expect(policy["std::bash"]).toEqual([{ action: "approve" }, { action: "reject" }]);
    expect(checkPolicyExplicit(policy, raise("std::bash"), DIRS)).toEqual({ type: "approve" });
  });

  it("layers the flags over the saved policy when the session has none of its own", () => {
    const policy = policyOf(
      sessionRunPolicy({
        carried: success(null),
        saved: { "std::read": [{ action: "reject" }] },
        extra: { "std::read": [{ action: "approve" }], "std::ls": [{ action: "approve" }] },
      }),
    );
    expect({ ...policy }).toEqual({
      "std::read": [{ action: "approve" }, { action: "reject" }],
      "std::ls": [{ action: "approve" }],
    });
  });

  it("does not change the policies it is given", () => {
    const carried: Policy = { "std::bash": [{ action: "reject" }] };
    const saved: Policy = { "std::bash": [{ action: "reject" }] };
    const extra: Policy = { "std::bash": [{ action: "approve" }] };
    sessionRunPolicy({ carried: success(carried), saved, extra });
    expect(carried).toEqual({ "std::bash": [{ action: "reject" }] });
    expect(saved).toEqual({ "std::bash": [{ action: "reject" }] });
    expect(extra).toEqual({ "std::bash": [{ action: "approve" }] });
  });
});

describe("rejectRulesOf", () => {
  it("keeps each effect's reject rules in order and drops effects with none", () => {
    const scoped = { match: { dir: "/secret/**" }, action: "reject" as const };
    const policy: Policy = {
      "std::read": [{ action: "approve" }, scoped, { action: "reject" }],
      "std::ls": [{ action: "approve" }],
      "*": [{ action: "propagate" }],
    };
    expect({ ...rejectRulesOf(policy) }).toEqual({
      "std::read": [scoped, { action: "reject" }],
    });
  });
});

function policyOf(result: Result<Policy>): Policy {
  if (!result.success) {
    throw new Error(`expected a policy, got: ${result.error}`);
  }
  return result.value;
}
