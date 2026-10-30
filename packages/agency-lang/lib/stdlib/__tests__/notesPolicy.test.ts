import { describe, it, expect } from "vitest";
import {
  checkPolicyExplicit as checkWith,
  type Policy,
  type PolicyDirs,
} from "../../runtime/policy.js";

// These rules match on `folder`, never on `dir`, so the directories a run
// resolves do not matter; a fixed set keeps the matcher happy.
const DIRS: PolicyDirs = {
  cwd: "/",
  agentHome: "/home/agent/.agency-agent",
  agencyInstallDir: null,
};
const checkPolicyExplicit = (policy: Policy, interrupt: Parameters<typeof checkWith>[1]) =>
  checkWith(policy, interrupt, DIRS);

// std::notes/apple passes "" for an omitted optional `folder`, never null.
// These tests pin that design through the REAL policy evaluator
// (checkPolicyExplicit → matchesRule → picomatch), not a parallel picomatch
// call, so they keep guarding the actual code path if the matcher ever
// changes how it normalizes values or which library it uses.

/** A std::notes::list interrupt as the module raises it, with the given folder. */
function listInterrupt(folder: unknown): {
  effect: string;
  message: string;
  data: any;
  origin: string;
} {
  return {
    effect: "std::notes::list",
    message: "List the notes in the Notes app?",
    data: { account: "", folder },
    origin: "",
  };
}

function approveWhenFolderMatches(pattern: string): Policy {
  return {
    "std::notes::list": [{ match: { folder: pattern }, action: "approve" }],
  };
}

describe("policy rules against an omitted folder", () => {
  it("an empty folder does not match a specific glob", () => {
    const result = checkPolicyExplicit(approveWhenFolderMatches("Work"), listInterrupt(""));
    expect(result).toBeNull();
  });

  it("an empty folder does not match a catch-all glob", () => {
    // The load-bearing one. If this ever approves, listNotes() with no
    // folder — the widest-reaching call in the module — starts matching any
    // {"folder": "*"} approve rule, and the payload design needs rethinking.
    expect(checkPolicyExplicit(approveWhenFolderMatches("*"), listInterrupt(""))).toBeNull();
    expect(checkPolicyExplicit(approveWhenFolderMatches("**"), listInterrupt(""))).toBeNull();
  });

  it("a real folder still matches", () => {
    expect(checkPolicyExplicit(approveWhenFolderMatches("*"), listInterrupt("Work"))).toEqual({
      type: "approve",
    });
    expect(checkPolicyExplicit(approveWhenFolderMatches("Work"), listInterrupt("Work"))).toEqual({
      type: "approve",
    });
  });

  it("a null folder does not match a folder rule either", () => {
    // The matcher treats a null field like a missing one, so a catch-all
    // folder rule does not approve a call that carries `folder: null`. The
    // module still normalizes an omitted folder to "" before it reaches
    // the payload, so a person approving the call sees one spelling.
    expect(checkPolicyExplicit(approveWhenFolderMatches("*"), listInterrupt(null))).toBeNull();
  });

  it("a rule with no match key still approves an empty folder", () => {
    // The limit of the empty-string design, pinned so nobody overclaims it:
    // "" protects against folder-GLOB rules, not against a bare catch-all.
    // {"action": "approve"} with no match approves every std::notes::list
    // interrupt, empty folder included.
    const catchAll: Policy = { "std::notes::list": [{ action: "approve" }] };
    expect(checkPolicyExplicit(catchAll, listInterrupt(""))).toEqual({ type: "approve" });
  });
});
