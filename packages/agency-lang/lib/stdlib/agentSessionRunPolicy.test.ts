import { describe, expect, it } from "vitest";
import {
  minimalAutoApprovePolicy,
  recommendedAutoApprovePolicy,
} from "../runtime/builtinPolicies.js";
import { checkPolicyExplicit, type Policy, type PolicyDirs } from "../runtime/policy.js";
import { failure, success, type Result } from "../types/result.js";
import { POLICY_UNREADABLE, sessionRunPolicy } from "./agentSessionPolicy.js";

const DIRS: PolicyDirs = {
  cwd: "/work",
  agentHome: "/home/me/.agency-agent",
  home: "/home/me",
  agencyInstallDir: null,
};

function raise(effect: string) {
  return { effect, message: "", data: {}, origin: "test" };
}

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

  // A session's policy replaces the saved one whole. A reject can depend
  // on the rules before it in its list, so it is not carried over alone.
  it("does not take the saved policy's rejects into a session with a policy of its own", () => {
    const saved: Policy = {
      "std::bash": [{ action: "reject" }],
      "std::read": [{ action: "approve" }],
    };
    const policy = policyOf(
      sessionRunPolicy({ carried: success(minimalAutoApprovePolicy), saved, extra: null }),
    );
    expect({ ...policy }).toEqual(minimalAutoApprovePolicy);
    expect(checkPolicyExplicit(policy, raise("std::bash"), DIRS)).toBeNull();
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

  // Someone who types `--approve std::bash` at resume means it.
  it("lets an --approve given at resume beat a reject the session was started with", () => {
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

function policyOf(result: Result<Policy>): Policy {
  if (!result.success) {
    throw new Error(`expected a policy, got: ${result.error}`);
  }
  return result.value;
}
