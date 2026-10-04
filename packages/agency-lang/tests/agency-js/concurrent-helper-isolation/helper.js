import { agency, getRuntimeContext } from "agency-lang/runtime";

// Waits, then charges `amount` to the run that called it and returns that
// run's cost so far. The wait matters: while this helper is paused, the
// other run in test.js gets its turn. If the helper woke up attached to the
// wrong run, the charge would land there.
export async function chargeLater(amount, waitMs) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  agency.addCost(amount);
  return getRuntimeContext().stack.localCost;
}
