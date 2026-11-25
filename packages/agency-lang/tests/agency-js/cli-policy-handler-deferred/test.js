import { childIsAsked, deferred, ruleDecides, takesGivenPolicy } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-deferred-"));
const policyFile = join(dir, "policy.json");

// Any prompt is the bug under test: a deferred interrupt is not asked about.
const inputOverride = async () => {
  throw new Error("Prompted while undecided interrupts are deferred");
};

// The child's interrupt is asked about once, and approved once.
const answers = ["a"];
const answerOnce = async () => {
  const answer = answers.shift();
  if (answer === undefined) throw new Error("Asked more than once");
  return answer;
};

try {
  const left = await deferred({ policyFile }, { inputOverride });
  const interrupts = Array.isArray(left.data) ? left.data : [];
  const decided = await ruleDecides({ policyFile }, { inputOverride });
  const child = await childIsAsked({ policyFile }, { inputOverride: answerOnce });
  const given = await takesGivenPolicy({ policyFile }, { inputOverride });
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        leftTheRun: interrupts.map((interrupt) => interrupt.effect),
        carriesACheckpoint: interrupts.every((interrupt) => interrupt.checkpoint != null),
        ruleDecides: String(decided.data),
        childWentOn: String(child.data).includes("the child went on"),
        childWasAskedOnce: answers.length === 0,
        givenPolicyRejects: String(given.data).startsWith("failure:"),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
