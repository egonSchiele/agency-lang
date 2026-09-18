import { savesSettings, doesNotSavePolicy, doesNotWriteSkills, readsItsOwnHome } from "./agent.js";
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
const answers = ["r", "", "r", ""];
globalThis.__agencyInputOverride = async () => {
  inputCalls += 1;
  return answers.shift() ?? "r";
};

try {
  const settings = (await savesSettings({ policyFile, home })).data;
  const policy = (await doesNotSavePolicy({ policyFile, home })).data;
  const skill = (await doesNotWriteSkills({ policyFile, home })).data;
  const read = (await readsItsOwnHome({ policyFile, home })).data;
  writeFileSync("__result.json", JSON.stringify({
    settings,
    policy,
    skill,
    read,
    // Two of the four had to ask, two calls each. The settings write and
    // the read drew nothing: no user was consulted at all.
    inputCalls,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
