import { main } from "./agent.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-value-no-rule-"));
const policyFile = join(dir, "policy.json");

// "aa" at a prompt that offered only a/r, then an answer for round two,
// which has to prompt because round one saved nothing.
const answers = ["aa", "a"];
let prompts = 0;
globalThis.__agencyInputOverride = async () => {
  prompts += 1;
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

let savedRules = "none";
try {
  await main({ policyFile });
  // The flush at the top of round two's handler entry would have written
  // any rule round one saved.
  savedRules = existsSync(policyFile) ? readFileSync(policyFile, "utf8").trim() : "none";
  writeFileSync("__result.json", JSON.stringify({
    prompts,
    remainingAnswers: answers.length,
    savedRules,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
