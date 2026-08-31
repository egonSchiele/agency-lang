// Issue #966: a top-level `with approve` must not bypass the root policy.
// Global init runs during bootstrap, so the root policy handler must already
// be in the chain when the top-level raise happens. Covers both policy
// sources: the AGENCY_RUN_POLICY environment policy (what the CLI's
// --reject/--policy flags set) and a host's InvocationOptions.policy.
import { readTop, __invokeNodeForServe } from "./agent.js";
import { writeFileSync } from "fs";

process.env.POLICY_TOP_LEVEL_SECRET = "the-secret";
const rejectEnv = { "std::env": [{ action: "reject" }] };

// 1. CLI surface: the env policy rejects the top-level read despite the
// program's own `with approve`.
process.env.AGENCY_RUN_POLICY = JSON.stringify(rejectEnv);
const cliRes = await readTop();
const cliRejected = cliRes.data === null;

// 2. Host surface: InvocationOptions.policy rejects it the same way.
delete process.env.AGENCY_RUN_POLICY;
const serveOutcome = await __invokeNodeForServe("readTop", {}, { policy: rejectEnv });
const hostRejected = serveOutcome.status === "returned" && serveOutcome.value.data === null;

// 3. Regression guard: with no policy at all, the top-level auto-approve
// still resolves the read.
const plainRes = await readTop();
const approvedWithoutPolicy = plainRes.data === "the-secret";

writeFileSync(
  "__result.json",
  JSON.stringify({ cliRejected, hostRejected, approvedWithoutPolicy }, null, 2),
);
