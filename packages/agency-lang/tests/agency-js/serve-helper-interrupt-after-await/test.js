// A helper that waits and then raises an interrupt, driven through the
// entry points `agency serve` uses. The helper holds its run from before
// the wait, so the interrupt reaches the same handlers under serve as it
// does under `agency run`.
import {
  bareFn,
  hasInterrupts,
  approve,
  __invokeNodeForServe,
  __invokeFunctionForServe,
  __respondToInterruptsForServe,
} from "./agent.js";
import { writeFileSync } from "fs";

function nodeData(outcome) {
  if (outcome.status !== "returned") {
    throw new Error(`expected a returned outcome, got: ${JSON.stringify(outcome.status)}`);
  }
  return outcome.value.data;
}

const approvePolicy = { "test::later": [{ action: "approve" }] };
const rejectPolicy = { "test::later": [{ action: "reject" }] };

// 1. The program's own handler approves.
const handled = nodeData(await __invokeNodeForServe("handled", {}, undefined));

// 2. The program's handler approves and the host policy rejects. Reject wins.
const hostRejects = nodeData(await __invokeNodeForServe("handled", {}, { policy: rejectPolicy }));

// 3. No handler in the program. The host policy approves.
const policyApproves = nodeData(await __invokeNodeForServe("bare", {}, { policy: approvePolicy }));

// 4. The same through a served function.
const fnPolicyApproves = await __invokeFunctionForServe(bareFn, {}, { policy: approvePolicy });

// 5. Nobody answers, so the interrupt surfaces. Approving it resumes the
// node, the helper runs again from its first line, and its raise returns
// the approval.
const paused = nodeData(await __invokeNodeForServe("bare", {}, undefined));
const surfaced = hasInterrupts(paused);
const resumed = surfaced
  ? nodeData(await __respondToInterruptsForServe(paused, [approve("from-host")], {}))
  : null;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      handled,
      hostRejects: hostRejects.type,
      policyApproves: policyApproves.type,
      fnPolicyApproves: { status: fnPolicyApproves.status, type: fnPolicyApproves.value?.type },
      surfaced,
      resumed,
    },
    null,
    2,
  ),
);
