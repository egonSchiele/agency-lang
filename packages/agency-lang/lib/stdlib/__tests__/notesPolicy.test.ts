import { describe, it, expect } from "vitest";
import { checkPolicyExplicit, type Policy } from "../../runtime/policy.js";

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

  it("a null folder FAILS OPEN, which is why payloads must never carry one", () => {
    // The real matcher does not throw on null; it coerces via String(null)
    // to the string "null", and a "*" glob matches that. So a null payload
    // field would let a catch-all folder rule approve a call the empty
    // string correctly refuses. This is the strongest reason the module
    // normalizes an omitted folder to "" before it reaches the payload.
    expect(checkPolicyExplicit(approveWhenFolderMatches("*"), listInterrupt(null))).toEqual({
      type: "approve",
    });
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
