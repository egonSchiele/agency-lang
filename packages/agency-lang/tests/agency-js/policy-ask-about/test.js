import { main, withoutHandler } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-ask-about-"));
const policyFile = join(dir, "policy.json");

// Scripted answers, used in order: "aa" approves std::read always, "r"
// rejects the deploy once, and the last is the follow-up message. A prompt
// past these throws, so an extra prompt fails the test instead of hanging.
const answers = ["aa", "r", "use staging"];
const inputOverride = async () => {
  const answer = answers.shift();
  if (answer === undefined) throw new Error("Unexpected extra input() call");
  return answer;
};

try {
  const unhandled = await withoutHandler({ root: dir }, { inputOverride });
  const result = await main({ policyFile, root: dir }, { inputOverride });
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        withoutHandler: unhandled.data,
        ...result.data,
        remainingAnswers: answers.length,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
