import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-parallel-"));
const policyFile = join(dir, "policy.json");

// One answer for three tool calls made in one LLM round. A second prompt
// would ask for an answer that is not here, and the override throws.
const answers = ["aa"];
globalThis.__agencyInputOverride = async () => {
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

try {
  const result = await main({ policyFile });
  writeFileSync("__result.json", JSON.stringify({
    result: result.data,
    remainingAnswers: answers.length,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
