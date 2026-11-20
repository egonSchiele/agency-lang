import {
  answersOnlyFromTheStart,
  approvedByPolicy,
  main,
  nonInteractive,
  savedRulesFirst,
  withoutHandler,
} from "./agent.js";
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

// Scripted answers, used in order: "aa" approves std::read always, "aa"
// approves the program's own std::glob always, "r" rejects the deploy
// once, and the last is the follow-up message. A prompt past these throws,
// so an extra prompt fails the test instead of hanging.
const answers = ["aa", "aa", "r", "use staging"];
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
  const byPolicy = await approvedByPolicy(
    { policyFile: join(dir, "other-policy.json"), root: dir, runFile: join(dir, "other-run.json") },
    { inputOverride: noInput },
  );
  // A session's own file, which holds only an ls rule. The handler runs
  // on that plus a flag's bash rule, and is answered "always" once.
  const sessionFile = join(dir, "session-policy.json");
  writeFileSync(sessionFile, JSON.stringify({ "std::ls": [{ action: "approve" }] }));
  const onlyAnswers = ["aa"];
  const answersOnly = await answersOnlyFromTheStart(
    { root: dir, runFile: sessionFile },
    {
      inputOverride: async () => {
        const answer = onlyAnswers.shift();
        if (answer === undefined) throw new Error("Unexpected extra input() call");
        return answer;
      },
    },
  );
  // The run's own file, before main's answers add to it.
  writeFileSync(runFile, JSON.stringify({ "std::ls": [{ action: "approve" }] }));
  const result = await main({ policyFile, root: dir, runFile }, { inputOverride });
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        withoutHandler: unhandled.data,
        nonInteractive: headless.data,
        savedRulesFirst: saved.data,
        approvedByPolicy: byPolicy.data,
        answersOnlyFromTheStart: answersOnly.data,
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
