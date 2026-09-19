import { describe, expect, it } from "vitest";
import { checkPolicy } from "./policy.js";
import type { Policy } from "./policy.js";
import { appendPolicyRules, missingPolicyRules } from "./policyUpdate.js";
import { recommendedAutoApprovePolicy } from "./builtinPolicies.js";

describe("missingPolicyRules", () => {
  it("finds nothing when the saved policy is the base", () => {
    expect(missingPolicyRules(recommendedAutoApprovePolicy, recommendedAutoApprovePolicy)).toEqual(
      {},
    );
  });

  it("reports an effect the saved policy has never heard of", () => {
    const saved: Policy = { ...recommendedAutoApprovePolicy };
    delete saved["std::toolbox::removeStaging"];
    expect(missingPolicyRules(saved, recommendedAutoApprovePolicy)).toEqual({
      "std::toolbox::removeStaging": recommendedAutoApprovePolicy["std::toolbox::removeStaging"],
    });
  });

  it("reports only the rules that are missing from an effect it has", () => {
    const base: Policy = {
      "std::write": [
        { match: { dir: "/a", filename: "settings.json" }, action: "approve" },
        { match: { dir: "/b" }, action: "approve" },
      ],
    };
    const saved: Policy = { "std::write": [{ match: { dir: "/b" }, action: "approve" }] };
    expect(missingPolicyRules(saved, base)).toEqual({ "std::write": [base["std::write"][0]] });
  });

  it("compares a match by its entries, not by key order", () => {
    const base: Policy = { e: [{ match: { dir: "/a", filename: "f" }, action: "approve" }] };
    const saved: Policy = { e: [{ match: { filename: "f", dir: "/a" }, action: "approve" }] };
    expect(missingPolicyRules(saved, base)).toEqual({});
  });

  it("tells an approve from a reject of the same match", () => {
    const base: Policy = { e: [{ match: { dir: "/a" }, action: "approve" }] };
    const saved: Policy = { e: [{ match: { dir: "/a" }, action: "reject" }] };
    expect(missingPolicyRules(saved, base)).toEqual(base);
  });

  it("offers nothing for an effect the saved policy already decides outright", () => {
    const base: Policy = { e: [{ match: { dir: "/a" }, action: "approve" }] };
    expect(missingPolicyRules({ e: [{ action: "reject" }] }, base)).toEqual({});
    expect(missingPolicyRules({ e: [{ match: {}, action: "approve" }] }, base)).toEqual({});
  });
});

describe("missingPolicyRules under a blanket wildcard", () => {
  it("offers nothing, because any added rule would overturn the wildcard", () => {
    for (const action of ["reject", "approve"] as const) {
      const saved: Policy = { "*": [{ action }] };
      expect(missingPolicyRules(saved, recommendedAutoApprovePolicy)).toEqual({});
    }
  });

  it("still offers rules when the wildcard is scoped by a match", () => {
    const saved: Policy = { "*": [{ match: { dir: "/tmp" }, action: "reject" }] };
    const base: Policy = { e: [{ match: { dir: "/a" }, action: "approve" }] };
    expect(missingPolicyRules(saved, base)).toEqual(base);
  });
});

describe("appendPolicyRules", () => {
  it("leaves every decision the saved policy already made as it was", () => {
    const saved: Policy = { "std::write": [{ match: { dir: "/home" }, action: "reject" }] };
    const additions: Policy = {
      "std::write": [{ match: { dir: "/home", filename: "settings.json" }, action: "approve" }],
    };
    const merged = appendPolicyRules(saved, additions);
    expect(merged["std::write"]).toEqual([...saved["std::write"], ...additions["std::write"]]);
    const asked = {
      effect: "std::write",
      message: "",
      data: { dir: "/home", filename: "settings.json" },
      origin: "test",
    };
    expect(checkPolicy(merged, asked).type).toBe("reject");
  });

  it("does not change the policy it was given", () => {
    const saved: Policy = { a: [{ action: "propagate", match: { x: "1" } }] };
    const before = JSON.stringify(saved);
    appendPolicyRules(saved, { a: [{ action: "approve", match: { x: "2" } }], b: [] });
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("closes the gap: nothing is missing after the missing rules are added", () => {
    const saved: Policy = { "std::read": [{ match: { dir: "/mine" }, action: "approve" }] };
    const missing = missingPolicyRules(saved, recommendedAutoApprovePolicy);
    const merged = appendPolicyRules(saved, missing);
    expect(missingPolicyRules(merged, recommendedAutoApprovePolicy)).toEqual({});
    expect(merged["std::read"][0]).toEqual(saved["std::read"][0]);
  });
});
