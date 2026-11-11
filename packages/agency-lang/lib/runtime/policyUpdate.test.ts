import { describe, expect, it } from "vitest";
import { checkPolicy } from "./policy.js";
import { resolvePolicyDirs } from "./policyDirs.js";
import { nodeHost } from "../host/node/nodeHost.js";
import type { Policy } from "./policy.js";
import { appendPolicyRules, insertApproveRule, missingPolicyRules } from "./policyUpdate.js";
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
    expect(checkPolicy(merged, asked, resolvePolicyDirs(nodeHost())).type).toBe("reject");
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

  it("treats rules that differ only in matchDotFolders as different", () => {
    const rule = { match: { dir: "/a" }, action: "approve" as const };
    const saved: Policy = { e: [rule] };
    const base: Policy = { e: [{ ...rule, matchDotFolders: true }] };
    expect(missingPolicyRules(saved, base)).toEqual(base);
  });
});

describe("insertApproveRule", () => {
  const rule = { match: { dir: "/a" }, action: "approve" as const, matchDotFolders: true };
  const reject = { match: { dir: "/a/secret" }, action: "reject" as const };
  const approve = { match: { dir: "/b" }, action: "approve" as const };
  const read = (dir: string) => ({ effect: "e", message: "", data: { dir }, origin: "test" });

  it("puts the rule after the reject rules and before the others", () => {
    const saved: Policy = { e: [reject, approve, { action: "propagate" }] };
    const next = insertApproveRule(saved, ["e", "f"], rule);
    expect(next).toEqual({ e: [reject, rule, approve, { action: "propagate" }], f: [rule] });
  });

  it("keeps a reject for a folder inside the approved one deciding", () => {
    const parent = { match: { dir: "{/p,/p/**}" }, action: "approve" as const };
    const saved: Policy = {
      e: [{ match: { dir: "{/p/secrets,/p/secrets/**}" }, action: "reject" }],
    };
    const next = insertApproveRule(saved, ["e"], parent);
    const dirs = resolvePolicyDirs(nodeHost());
    expect(checkPolicy(next, read("/p/secrets/keys"), dirs).type).toBe("reject");
    expect(checkPolicy(next, read("/p/src"), dirs).type).toBe("approve");
  });

  it("does not change the policy it was given", () => {
    const saved: Policy = { e: [reject] };
    const before = JSON.stringify(saved);
    insertApproveRule(saved, ["e"], rule);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("saves one copy when the same rule is added twice", () => {
    const once = insertApproveRule({ e: [reject] }, ["e"], rule);
    expect(insertApproveRule(once, ["e"], { ...rule })).toEqual({ e: [reject, rule] });
  });

  it("returns an equal policy for an empty effect list", () => {
    const saved: Policy = { e: [reject] };
    expect(insertApproveRule(saved, [], rule)).toEqual(saved);
  });

  it("keeps a scoped reject under * deciding for a folder inside the approved one", () => {
    const secrets = { match: { dir: "{/p/secrets,/p/secrets/**}" }, action: "reject" as const };
    const saved: Policy = { "*": [secrets] };
    const dirs = resolvePolicyDirs(nodeHost());
    const readIn = (dir: string) => ({ ...read(dir), effect: "std::read" });
    expect(checkPolicy(saved, readIn("/p/src"), dirs).type).toBe("propagate");
    const parent = {
      match: { dir: "{/p,/p/**}" },
      action: "approve" as const,
      matchDotFolders: true,
    };
    const next = insertApproveRule(saved, ["std::read"], parent);
    expect(checkPolicy(next, readIn("/p/secrets/keys"), dirs).type).toBe("reject");
    expect(checkPolicy(next, readIn("/p/src"), dirs).type).toBe("approve");
    expect(next["std::read"]).toEqual([secrets, parent]);
  });

  it("does not copy a catch-all reject under *, which would hide every rule after it", () => {
    const saved: Policy = { "*": [{ action: "reject" }], e: [approve] };
    expect(insertApproveRule(saved, ["e"], rule)["e"]).toEqual([rule, approve]);
  });

  it("goes ahead of a catch-all propagate that would hide it", () => {
    const saved: Policy = { e: [{ action: "propagate" }, reject] };
    const next = insertApproveRule(saved, ["e"], rule);
    expect(next["e"]).toEqual([rule, { action: "propagate" }, reject]);
    expect(checkPolicy(next, read("/a"), resolvePolicyDirs(nodeHost())).type).toBe("approve");
  });

  it("goes after a catch-all reject, which still decides", () => {
    const saved: Policy = { e: [{ action: "reject" }] };
    expect(insertApproveRule(saved, ["e"], rule)["e"]).toEqual([{ action: "reject" }, rule]);
  });
});
