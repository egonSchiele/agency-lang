// Runs the fork under two root policies.
//
// - Reject: both arms are rejected. The "own" arm's `with approve` loses,
//   because a rejection from any handler in the chain wins. If the root
//   policy were skipped inside the arm, "own" would be approved.
// - Approve: both arms are approved. The "bare" arm has no handler of its
//   own, so only the root policy can answer it. If the root policy were
//   skipped, its interrupt would come back to this script instead.
// - No policy, the control: the "bare" arm's interrupt comes back to this
//   script, which shows the approvals above came from the policy. Only
//   that one interrupt comes back, which shows the "own" arm's approval
//   still works on its own.
import { writeFileSync } from "fs";
import { main, hasInterrupts } from "./agent.js";

const policyFor = (action) => JSON.stringify({ "test::arm": [{ action }] });

async function runWith(action) {
  if (action !== null) {
    process.env.AGENCY_RUN_POLICY = policyFor(action);
  }
  try {
    const result = await main();
    if (hasInterrupts(result.data)) {
      return { interrupted: result.data.map((intr) => intr.message) };
    }
    return result.data;
  } finally {
    delete process.env.AGENCY_RUN_POLICY;
  }
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      rejectPolicy: await runWith("reject"),
      approvePolicy: await runWith("approve"),
      noPolicy: await runWith(null),
    },
    null,
    2,
  ),
);
