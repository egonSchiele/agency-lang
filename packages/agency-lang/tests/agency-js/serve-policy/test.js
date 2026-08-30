// End-to-end for the serve-host root policy: a compiled module driven through
// the serve entry points (__invokeNodeForServe / __invokeFunctionForServe /
// __respondToInterruptsForServe) with InvocationOptions.policy. env() absorbs
// a denial, so a policy reject shows up as null, never as a failed run.
import {
  readVarFn,
  hasInterrupts,
  approve,
  __invokeNodeForServe,
  __invokeFunctionForServe,
  __respondToInterruptsForServe,
} from "./agent.js";
import { writeFileSync } from "fs";

process.env.SERVE_POLICY_A = "value-a";
process.env.SERVE_POLICY_B = "value-b";
process.env.SERVE_POLICY_SECRET = "the-secret";

// Approve reads of SERVE_POLICY_A by name; reject every other env read.
const approveAOnly = {
  "std::env": [{ match: { name: "SERVE_POLICY_A" }, action: "approve" }, { action: "reject" }],
};

function nodeData(outcome) {
  if (outcome.status !== "returned") {
    throw new Error(`expected a returned outcome, got: ${JSON.stringify(outcome.status)}`);
  }
  return outcome.value.data;
}

// 1. Policy approve: the read happens, nothing surfaces.
const approved = nodeData(
  await __invokeNodeForServe("readVar", { name: "SERVE_POLICY_A" }, { policy: approveAOnly }),
);

// 2. Policy reject: env() absorbs the denial; the variable reads as unset.
const rejected = nodeData(
  await __invokeNodeForServe("readVar", { name: "SERVE_POLICY_SECRET" }, { policy: approveAOnly }),
);

// 3. SECURITY-CRITICAL (do not fold into case 2): the program auto-approves
// its own read, and the host policy reject must still win. Case 2 proves
// nothing about precedence — there is no inner handler to beat.
const rejectedOverApprove = nodeData(
  await __invokeNodeForServe(
    "readVarApproved",
    { name: "SERVE_POLICY_SECRET" },
    { policy: approveAOnly },
  ),
);

// 4. A policy propagate rule surfaces the interrupt even over the program's
// own approving handler: the host's "always ask me".
const propagatePolicy = { "std::env": [{ action: "propagate" }] };
const propagated = nodeData(
  await __invokeNodeForServe(
    "readVarApproved",
    { name: "SERVE_POLICY_A" },
    { policy: propagatePolicy },
  ),
);

// 5. A served FUNCTION is governed by the same bootstrap install.
const fnApproved = await __invokeFunctionForServe(
  readVarFn,
  { name: "SERVE_POLICY_A" },
  { policy: approveAOnly },
);
const fnRejected = await __invokeFunctionForServe(
  readVarFn,
  { name: "SERVE_POLICY_SECRET" },
  { policy: approveAOnly },
);

// 6. A raise made DURING a resume leg hits the re-installed root policy.
// The policy has no rule for the first read, so it surfaces; the caller
// approves it; the second read is then rejected at its raise and reads null.
const rejectBOnly = {
  "std::env": [{ match: { name: "SERVE_POLICY_B" }, action: "reject" }],
};
const paused = nodeData(await __invokeNodeForServe("twoReads", {}, { policy: rejectBOnly }));
if (!hasInterrupts(paused)) {
  throw new Error("expected the first read of twoReads to surface");
}
const resumed = await __respondToInterruptsForServe(paused, [approve()], {
  invocation: { policy: rejectBOnly },
});

// 6b. Control: with no policy on either leg, the second read surfaces as a
// second interrupt instead of reading null — proving 6's null came from the
// re-installed policy, not from the effect itself.
const controlPaused = nodeData(await __invokeNodeForServe("twoReads", {}, undefined));
if (!hasInterrupts(controlPaused)) {
  throw new Error("expected the first read of the control twoReads to surface");
}
const controlResumed = await __respondToInterruptsForServe(controlPaused, [approve()], {});
const controlSecondSurfaced = hasInterrupts(controlResumed.value.data);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      approved,
      rejected,
      rejectedOverApprove,
      propagatedSurfaced: hasInterrupts(propagated),
      fnApproved: { status: fnApproved.status, value: fnApproved.value },
      fnRejected: { status: fnRejected.status, value: fnRejected.value },
      resumeLeg: {
        status: resumed.status,
        value: nodeData(resumed),
      },
      controlSecondSurfaced,
    },
    null,
    2,
  ),
);
