import { main } from "./agent.js";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-prompt-wait-"));
const policyFile = join(dir, "policy.json");
const SECRET = "sk-test-not-a-real-key";

// "a" approves the deploy; the secret is the typed answer to the second
// prompt, which asks for a value.
const answers = ["a", SECRET];
const inputOverride = async () => {
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

try {
  const result = await main({ policyFile }, { inputOverride });
  const log = readFileSync("statelog.log", "utf-8");
  const waits = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).data)
    .filter((data) => data.type === "promptWait");
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        returned: result.data === SECRET,
        remainingAnswers: answers.length,
        answers: waits.map((wait) => wait.answer),
        waitsAreNumbers: waits.every((wait) => typeof wait.waitMs === "number"),
        // The typed answer is not copied into promptWait.
        waitsHoldNoSecret: !JSON.stringify(waits).includes(SECRET),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
