// The judge's policy check must see the run's root policy: the one
// `agency run --policy` puts in AGENCY_RUN_POLICY, and the `policy` option
// a host passes, which is how the agent's session driver gives a session
// its policy. Neither is the policy of a cliPolicyHandler.
//
// The rule approves the line's std::bash question, as an "always approve"
// answer would. Every judge mock refuses, so the line runs only if the
// check saw the rule and skipped the judge.
import { judgedLine, __invokeNodeForServe } from "./driver.js";
import { writeFileSync } from "fs";

// `|` is a glob character, so a rule names the command escaped, as a saved
// rule does.
const approveLine = {
  "std::bash": [{ action: "approve", match: { command: "printf hi \\| awk NF" } }],
};

// 1. The CLI surface: agency run --policy.
process.env.AGENCY_RUN_POLICY = JSON.stringify(approveLine);
const viaRunPolicy = (await judgedLine()).data;
delete process.env.AGENCY_RUN_POLICY;

// 2. The host surface: the session driver's `policy` option.
const served = await __invokeNodeForServe("judgedLine", {}, { policy: approveLine });
const viaPolicyOption =
  served.status === "returned" ? served.value.data : `not returned: ${JSON.stringify(served)}`;

// 3. Control: with no policy, the judge is asked and refuses. Without this,
// cases 1 and 2 could pass because the judge was never reached at all.
const withoutPolicy = (await judgedLine()).data;

writeFileSync(
  "__result.json",
  JSON.stringify({ viaRunPolicy, viaPolicyOption, withoutPolicy }, null, 2),
);
