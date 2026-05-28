import { agency, getRuntimeContext } from "agency-lang/runtime";

// Pins that `agency.llm` from a TS helper:
//   1. consumes the deterministic-provider mock and returns its
//      string output to the caller.
//   2. charges the per-call cost (SYNTHETIC_COST.totalCost = 0.000002
//      under the deterministic client) to the active branch's
//      `stack.localCost` — the same accumulator user agency code's
//      built-in `llm(...)` writes to.
//
// `lastCost` lives in module state so the agency entry can read the
// post-call cost AFTER `run()` returns, without needing to thread an
// extra return value through the agency layer.
let lastCost = 0;

export function getCost() {
  return lastCost;
}

export async function run() {
  const result = await agency.llm("say hi");
  lastCost = getRuntimeContext().stack.localCost;
  return result;
}
