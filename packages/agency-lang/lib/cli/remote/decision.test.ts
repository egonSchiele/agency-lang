import { describe, it, expect, vi } from "vitest";
import { approve, reject } from "@/runtime/interruptResponse.js";
import type { Interrupt } from "@/runtime/interrupts.js";

const resolveRunPolicy = vi.fn();
vi.mock("@/cli/runPolicy.js", () => ({
  resolveRunPolicy: (...args: unknown[]) => resolveRunPolicy(...args),
}));

// Imported after the mock so decision.ts binds the mocked resolveRunPolicy.
const { resolveRemoteDecision } = await import("./decision.js");

function intr(effect: string): Interrupt {
  return { type: "interrupt", effect, message: "", data: null, origin: "", interruptId: "i", runId: "r" };
}

describe("resolveRemoteDecision", () => {
  it("returns null when no interrupt flag was given", () => {
    resolveRunPolicy.mockReturnValue(null);
    expect(resolveRemoteDecision({})).toBeNull();
  });

  it("consumes the parsed policy, not policyJson (approves a policy-approved effect)", async () => {
    // policyJson is deliberately garbage — a decider that re-parsed it would break.
    resolveRunPolicy.mockReturnValue({
      policy: { X: [{ action: "approve" }] },
      policyJson: "GARBAGE",
      interactive: false,
    });
    const decide = resolveRemoteDecision({ approve: "X" });
    expect(decide).not.toBeNull();
    expect(await decide!(intr("X"))).toEqual(approve());
  });

  it("rejects a non-matching effect when non-interactive", async () => {
    resolveRunPolicy.mockReturnValue({ policy: {}, policyJson: "{}", interactive: false });
    const decide = resolveRemoteDecision({ reject: "Y" });
    expect(await decide!(intr("Z"))).toEqual(reject());
  });

  it("propagates an invalid-policy error (same as agency run)", () => {
    resolveRunPolicy.mockImplementation(() => {
      throw new Error('unknown policy "bogus"');
    });
    expect(() => resolveRemoteDecision({ policy: "bogus" })).toThrow(/unknown policy/);
  });
});
