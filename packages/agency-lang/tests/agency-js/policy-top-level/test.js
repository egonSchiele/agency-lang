// Issue #966: top-level raises must be decided by the root policy.
// Global init runs during bootstrap, so the root policy handler must already
// be in the chain when a top-level raise happens. Covers both policy
// sources: the AGENCY_RUN_POLICY environment policy (what the CLI's
// --reject/--approve/--policy flags set) and a host's InvocationOptions.policy.
import { readTop, __invokeNodeForServe } from "./agent.js";
import { writeFileSync } from "fs";

process.env.POLICY_TOP_LEVEL_SECRET = "the-secret";
process.env.POLICY_TOP_LEVEL_BARE = "bare-secret";
const s = (x) => JSON.stringify(x);
const rejectEnv = { "std::env": [{ action: "reject" }] };

// 1. CLI surface: the env policy rejects the top-level read despite the
// program's own `with approve`.
process.env.AGENCY_RUN_POLICY = s(rejectEnv);
const cliRejected = (await readTop()).data.withApprove === null;

// 2. Approve policy: a bare top-level raise, which fails closed with no
// policy (case 6), is resolved by the root policy. This is the positive
// control showing the handler is in the chain during global init.
process.env.AGENCY_RUN_POLICY = s({ "std::env": [{ action: "approve" }] });
const bareApprovedByPolicy = (await readTop()).data.bare === "bare-secret";

// 3. Propagate policy: propagation beats the program's `with approve`, and
// global init cannot pause to ask, so the read fails closed (env absorbs
// the failure to null) instead of self-approving.
process.env.AGENCY_RUN_POLICY = s({ "std::env": [{ action: "propagate" }] });
const propagateFailsClosed = (await readTop()).data.withApprove === null;

// 4. Host surface: InvocationOptions.policy rejects the same way the env
// policy does in case 1.
delete process.env.AGENCY_RUN_POLICY;
const serveOutcome = await __invokeNodeForServe("readTop", {}, { policy: rejectEnv });
const hostRejected =
  serveOutcome.status === "returned" && serveOutcome.value.data.withApprove === null;

// 5. Positive control for the serve leg: with no policy, the served read
// returns the secret. Without this, case 4's null could come from the serve
// leg failing env reads for an unrelated reason.
const plainServe = await __invokeNodeForServe("readTop", {}, {});
const servedWithoutPolicy =
  plainServe.status === "returned" && plainServe.value.data.withApprove === "the-secret";

// 6. No policy at all, direct call: the top-level auto-approve still
// resolves its own read (regression guard for `with approve` in global
// scope), and the bare raise still fails closed.
const plain = (await readTop()).data;
const approvedWithoutPolicy = plain.withApprove === "the-secret";
const bareFailsClosedWithoutPolicy = plain.bare === null;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      cliRejected,
      bareApprovedByPolicy,
      propagateFailsClosed,
      hostRejected,
      servedWithoutPolicy,
      approvedWithoutPolicy,
      bareFailsClosedWithoutPolicy,
    },
    null,
    2,
  ),
);
