import { updatesASavedPolicy, unsavedRulesDoNotApply } from "./agent.js";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const home = realpathSync(mkdtempSync(join(tmpdir(), "policy-update-home-")));
process.env.AGENCY_AGENT_HOME = home;
const toolsDir = join(home, "tools");
mkdirSync(toolsDir);
const policyFile = join(home, "policy.json");

// A policy saved before `recommended` knew about removeStaging, with two
// rules of the user's own: a blanket reject, and a scoped one.
const saved = {
  "std::bash": [{ action: "reject" }],
  "std::read": [{ match: { dir: "/mine" }, action: "approve" }],
};
writeFileSync(policyFile, JSON.stringify(saved));

// "r" rejects, so the removal that asks shows up as a failure rather than
// a hang. A rejection asks twice: the menu, then the reason.
let inputCalls = 0;
globalThis.__agencyInputOverride = async () => {
  inputCalls += 1;
  // Odd calls are the menu, even calls the reason.
  return inputCalls % 2 === 1 ? "r" : "";
};

try {
  const report = (await updatesASavedPolicy({ policyFile, toolsDir })).data;
  const onDisk = JSON.parse(readFileSync(policyFile, "utf8"));
  const callsForUpdate = inputCalls;
  const unsaved = (
    await unsavedRulesDoNotApply({ policyFile: join(home, "no-such-dir", "policy.json"), toolsDir })
  ).data;
  writeFileSync("__result.json", JSON.stringify({
    report,
    inputCalls: callsForUpdate,
    // The write failed, so the removal still asks.
    unsaved,
    // The user's blanket reject decides std::bash, so nothing was added to it.
    bashRules: onDisk["std::bash"],
    // The user's own read rule is still first.
    firstReadRule: onDisk["std::read"][0],
    readRulesGrew: onDisk["std::read"].length > 1,
    removeStagingOnDisk: onDisk["std::toolbox::removeStaging"] !== undefined,
  }, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
}
