import type { AgencyConfig } from "@/config.js";
import { makeStatelogCostTailer } from "./costTail.js";
import * as fs from "fs";

/** `eval.limits.maxBatchCostUsd`, or undefined when the config sets no
 *  batch-wide cap. Unlike the per-run cap there is no default: a suite's
 *  size is the user's, so is its budget. */
export function batchCostCapFromConfig(config: AgencyConfig): number | undefined {
  const cap = config.eval?.limits?.maxBatchCostUsd;
  const valid = typeof cap === "number" && Number.isFinite(cap) && cap > 0;
  return valid ? cap : undefined;
}

export type BatchBudget = {
  /** Record one finished run's spend; true when this crossed the cap. */
  add(costUsd: number): boolean;
  exhausted(): boolean;
  spentUsd(): number;
  exceededMessage(): string;
};

/** Spend across one `eval run` invocation, summed from finished runs. The
 *  suite stops STARTING runs once the cap is crossed; runs already in flight
 *  finish under their own per-run cap, so the worst case is the batch cap
 *  plus `parallel` per-run caps. */
export function makeBatchBudget(capUsd: number | undefined): BatchBudget {
  let spent = 0;
  let exhausted = false;
  return {
    add(costUsd: number): boolean {
      spent += costUsd;
      if (capUsd === undefined || exhausted || spent <= capUsd) return false;
      exhausted = true;
      return true;
    },
    exhausted: () => exhausted,
    spentUsd: () => spent,
    exceededMessage: () =>
      `batch cost cap exceeded: $${spent.toFixed(2)} spent, cap $${(capUsd ?? 0).toFixed(2)} ` +
      `(eval.limits.maxBatchCostUsd raises it); no further tests will start`,
  };
}

/** A finished run's LLM spend, read from its statelog; 0 when it left none. */
export function runCostUsd(statelogPath: string | null): number {
  if (statelogPath === null || !fs.existsSync(statelogPath)) return 0;
  return makeStatelogCostTailer(statelogPath).poll();
}
