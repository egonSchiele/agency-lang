import { main, nonInteractive, savedRulesFirst, withoutHandler } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-ask-about-"));
// The handler's own file approves every read and rejects every write. The
// run's policy says neither, and its "always" answers go to `runFile`.
const policyFile = join(dir, "policy.json");
writeFileSync(
  policyFile,
  JSON.stringify({ "std::read": [{ action: "approve" }], "std::write": [{ action: "reject" }] }),
);
const runFile = join(dir, "run-policy.json");

// Scripted answers, used in order: "aa" approves std::read always, "r"
// rejects the deploy once, and the last is the follow-up message. A prompt
// past these throws, so an extra prompt fails the test instead of hanging.
const answers = ["aa", "r", "use staging"];
const inputOverride = async () => {
  const answer = answers.shift();
  if (answer === undefined) throw new Error("Unexpected extra input() call");
  return answer;
};

// The non-interactive run gets no answers: any prompt throws.
const noInput = async () => {
  throw new Error("Unexpected input() call in a non-interactive run");
};

try {
  const unhandled = await withoutHandler({ root: dir, runFile }, { inputOverride });
  const headless = await nonInteractive(
    { policyFile: join(dir, "headless-policy.json"), root: dir, runFile },
    { inputOverride: noInput },
  );
  const savedPolicyFile = join(dir, "saved-policy.json");
  writeFileSync(savedPolicyFile, JSON.stringify({ "std::write": [{ action: "reject" }] }));
  const saved = await savedRulesFirst({ policyFile: savedPolicyFile }, { inputOverride: noInput });
  const result = await main({ policyFile, root: dir, runFile }, { inputOverride });
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        withoutHandler: unhandled.data,
        nonInteractive: headless.data,
        savedRulesFirst: saved.data,
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
