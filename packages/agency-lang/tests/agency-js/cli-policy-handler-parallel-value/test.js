import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-parallel-value-"));
const policyFile = join(dir, "policy.json");

// Both tool calls are answered "approve always". Which of the two
// reaches the terminal first is up to the scheduler, so the test does not
// assume: either way, both have to prompt. A rule saved by the plain
// raise must not answer the one that expects a value, and the one that
// expects a value must not save a rule at all, since its menu never
// offered that answer.
const answers = ["aa", "aa"];
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
