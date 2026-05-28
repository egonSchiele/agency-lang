import { agency, getRuntimeContext } from "agency-lang/runtime";

// Charges `amount` to the active branch's CostGuard accumulator,
// then reads back `stack.localCost` from the ALS-resolved per-branch
// stack. If branch isolation works, each branch sees only its own
// contribution (plus seedCost from the parent, which is 0 here
// because the parent does no addCost before the fork). If sibling
// branches leaked into each other's stacks, all three branches
// would see the sum.
export async function addAndReport(amount) {
  agency.addCost(amount);
  return getRuntimeContext().stack.localCost;
}
