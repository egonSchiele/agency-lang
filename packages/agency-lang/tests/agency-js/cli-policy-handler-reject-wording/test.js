import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-reject-wording-"));
const policyFile = join(dir, "policy.json");

// a: "r", then a reason at the follow-up prompt.
// b: a reason typed straight at the menu.
// c: "r", then enter with no reason.
// d: "rr", reject always.
const answers = ["r", "use ls instead", "why are you doing this?", "r", "", "rr"];
const inputOverride = async () => {
  const answer = answers.shift();
  if (answer === undefined) throw new Error("Unexpected extra input() call");
  return answer;
};

try {
  const result = await main({ policyFile }, { inputOverride });
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        reasons: result.data,
        remainingAnswers: answers.length,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
