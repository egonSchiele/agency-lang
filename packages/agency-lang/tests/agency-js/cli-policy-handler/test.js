import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-"));
const policyFile = join(dir, "policy.json");

// Scripted answers consumed in order. If the handler issues more
// prompts than we have answers, the override throws — surfacing the
// over-prompting as a clear test failure instead of a hang.
// The "1" picks the interrupt's own folder at the folder step that follows
// "ap" on std::read. The read names a folder inside `dir`, so the step has
// that folder and `dir` to offer wherever the agent home is. A folder
// directly in the temp directory would offer one folder, and no step, on a
// machine whose agent home is in the temp directory, as in CI.
const answers = ["aa", "ap", "1", "a"];
const inputOverride = async () => {
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

try {
  const result = await main({ policyFile, root: dir }, { inputOverride });

  writeFileSync("__result.json", JSON.stringify({
    result: result.data,
    remainingAnswers: answers.length,  // 0 = all consumed correctly
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
