import type { Guard } from "./guard.js";
import type { StateStack } from "./state/stateStack.js";

/**
 * The Agency-level guard: the set of runtime guards one `guard(...)` call
 * pushed. `guard(cost: $1, time: 5m)` pushes a CostGuard AND a TimeGuard —
 * two objects, two guardIds — and everything user-facing (the trip
 * interrupt, the approve payload naming both dimensions, disarm lists,
 * the root-budget refusal) is about the PAIR. This class is the pair's
 * name. It is never stored: construct it on demand from a stack plus the
 * member ids, which ARE stored (`Guard.scopeIds`).
 *
 * Resolution is ALWAYS against a specific branch's stack, never a global
 * registry: fork time-clones carry the parent's guardId, so only the
 * raising branch's own stack knows which physical object answers to an
 * id there. That one rule is what makes approve routing correct across
 * fork, race, and the subprocess boundary (the answer is applied at the
 * raise site, in the process and branch that own the guard).
 */
export class GuardScope {
  private constructor(private readonly members: Guard[]) {}

  /** The scope a tripped guard belongs to, resolved on `stack`. Members
   *  are matched innermost-first by id. A guard with an empty scopeIds
   *  (root budgets, agency.withCostGuard) is its own single-member
   *  scope. Returns null when no member is present on this stack —
   *  callers treat that as a stale or foreign answer, a runtime error,
   *  never a silent no-op. */
  static resolve(stack: StateStack, tripped: Guard): GuardScope | null {
    const ids = tripped.scopeIds.length > 0 ? tripped.scopeIds : [tripped.guardId];
    const members: Guard[] = [];
    for (let i = stack.guards.length - 1; i >= 0; i--) {
      const g = stack.guards[i];
      if (ids.includes(g.guardId) && !members.includes(g)) {
        members.push(g);
      }
    }
    return members.length > 0 ? new GuardScope(members) : null;
  }

  memberFor(dimension: "cost" | "time"): Guard | null {
    return this.members.find((g) => g.dimension === dimension) ?? null;
  }

  /** User code cannot approve its way past the operator: a scope with a
   *  root member refuses extension wholesale. */
  containsRootBudget(): boolean {
    return this.members.some((g) => g.isRootBudget);
  }

  memberIds(): string[] {
    return this.members.map((g) => g.guardId);
  }

  /** Apply a merged approve payload. Grants are ADDITIVE per named
   *  dimension (negative deltas clamp to zero with a warning — see
   *  clampGrant); an omitted dimension continues unchanged with its
   *  remaining allowance; `disarm` names dimensions to stop metering.
   *  Throws GuardApproveError on: a root scope, a payload naming a
   *  dimension this scope does not have, or an answer that leaves the
   *  TRIPPED dimension still over budget and armed — that answer would
   *  re-trip forever (the handler-chain recursion guard cannot catch the
   *  loop; its depth resets on every fresh trip). */
  extend(
    payload: {
      maxCost?: number;
      maxTime?: number;
      disarm?: ("cost" | "time")[];
      message?: string;
    },
    tripped: "cost" | "time",
  ): void {
    if (this.containsRootBudget()) {
      throw new GuardApproveError(
        "this guard is an operator root budget (--max-cost/--max-time); it cannot be extended from code",
      );
    }
    // Read keys defensively (`!== undefined`, never presence): a lone
    // approval arrives with only its own keys, a merged one with all
    // four — see effectMerge.ts.
    const grants: Array<["cost" | "time", number | undefined]> = [
      ["cost", payload.maxCost],
      ["time", payload.maxTime],
    ];
    for (const [dimension, delta] of grants) {
      if (delta === undefined) continue;
      const member = this.memberFor(dimension);
      if (!member) {
        throw new GuardApproveError(
          `the approval grants ${dimension} budget, but this guard has no ${dimension} limit`,
        );
      }
      member.extendBudget(delta);
    }
    for (const dimension of payload.disarm ?? []) {
      const member = this.memberFor(dimension);
      if (!member) {
        throw new GuardApproveError(
          `the approval disarms ${dimension}, but this guard has no ${dimension} limit`,
        );
      }
      member.disarm();
    }
    const trippedMember = this.memberFor(tripped);
    if (trippedMember && trippedMember.overBudgetAndArmed()) {
      throw new GuardApproveError(
        `the approval leaves the tripped ${tripped} budget still exceeded ` +
          `and armed — the guard would trip again immediately. Grant ` +
          `budget on the tripped dimension (approve({max` +
          `${tripped === "cost" ? "Cost" : "Time"}: ...})) or disarm it ` +
          `explicitly (approve({disarm: ["${tripped}"]})).`,
      );
    }
  }

  /** The interrupt-data fields describing this scope at raise time. */
  snapshot(tripped: "cost" | "time"): {
    label: string | null;
    scopeIds: string[];
    dimension: "cost" | "time";
    limit: number;
    spent: number;
    maxCost: number | null;
    maxTime: number | null;
  } {
    const cost = this.memberFor("cost");
    const time = this.memberFor("time");
    const trippedMember = this.memberFor(tripped)!;
    return {
      label: trippedMember.label ?? null,
      scopeIds: this.memberIds(),
      dimension: tripped,
      limit: trippedMember.currentLimit(),
      spent: trippedMember.spentAmount(),
      maxCost: cost ? cost.currentLimit() : null,
      maxTime: time ? time.currentLimit() : null,
    };
  }

  /** Freeze the scope while its trip is being decided: the members and
   *  every guard installed AFTER the innermost member stop gating,
   *  charging, and ticking ON THIS BRANCH. Uses the stack's suspension
   *  bracket (branch-scoped) — NOT object flags — for the same reason
   *  handler suspension does: a shared CostGuard flagged object-wide
   *  would blind sibling branches (see PR 1's deviation note in the
   *  resumable-guards plan). Returns the token endSuspension needs. */
  suspendForDecision(stack: StateStack): string[] {
    const memberIds = this.memberIds();
    const firstMemberIndex = stack.guards.findIndex((g) =>
      memberIds.includes(g.guardId),
    );
    const visible = stack.guards
      .slice(0, firstMemberIndex === -1 ? stack.guards.length : firstMemberIndex)
      .map((g) => g.guardId);
    return stack.beginSuspension(visible);
  }
}

/** A defective answer to a guard trip — attributed to the answering
 *  handler by the chain machinery. Plain Error: this is the exception
 *  domain (a bug in supervisory code), not an abort or a failure. */
export class GuardApproveError extends Error {
  constructor(message: string) {
    super(`guard approval error: ${message}`);
    this.name = "GuardApproveError";
  }
}

