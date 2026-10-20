import {
  doesNotSaveSettings,
  doesNotSavePolicy,
  doesNotWriteSkills,
  readsItsMemory,
  readsItsSettings,
  doesNotReadSessions,
} from "./agent.js";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-agent-home-"));
const policyFile = join(dir, "policy.json");
// The agent home the rules are written against. realpath because that is
// the spelling a file effect puts in its payload, and what the matcher
// expands `<agent-home>` to.
const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-home-")));
process.env.AGENCY_AGENT_HOME = home;

// "r" rejects, so anything that asks shows up as a rejection rather than
// a hang. A rejection asks twice: the menu, then "what should the agent
// do instead", which "" declines.
let inputCalls = 0;
const answers = ["r", "", "r", "", "r", "", "r", ""];
const inputOverride = async () => {
  inputCalls += 1;
  return answers.shift() ?? "r";
};

try {
  const settings = (await doesNotSaveSettings({ inputOverride, policyFile, home })).data;
  const policy = (await doesNotSavePolicy({ inputOverride, policyFile, home })).data;
  const skill = (await doesNotWriteSkills({ inputOverride, policyFile, home })).data;
  const memory = (await readsItsMemory({ inputOverride, policyFile, home })).data;
  const settingsRead = (await readsItsSettings({ inputOverride, policyFile, home })).data;
  const sessions = (await doesNotReadSessions({ inputOverride, policyFile, home })).data;
  writeFileSync("__result.json", JSON.stringify({
    settings,
    policy,
    skill,
    memory,
    settingsRead,
    sessions,
    // Four of the six had to ask, two calls each. The other two drew
    // nothing: no user was consulted for them at all.
    inputCalls,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
