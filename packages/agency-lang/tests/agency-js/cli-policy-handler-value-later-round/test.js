import { main } from "./agent.js";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-value-later-"));
const policyFile = join(dir, "policy.json");

// "aa" in round one saves the rule. Round two has to prompt anyway, so
// there is a second answer for it.
const answers = ["aa", "a"];
let prompts = 0;
globalThis.__agencyInputOverride = async () => {
  prompts += 1;
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

try {
  await main({ policyFile });
  writeFileSync("__result.json", JSON.stringify({
    prompts,
    remainingAnswers: answers.length,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
