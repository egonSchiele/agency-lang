import { main, rejectMessageCase } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-"));
const policyFile = join(dir, "policy.json");

// Scripted answers consumed in order. If the handler issues more
// prompts than we have answers, the override throws — surfacing the
// over-prompting as a clear test failure instead of a hang.
const answers = ["aa", "ap", "a"];
globalThis.__agencyInputOverride = async () => {
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

try {
  const result = await main({ policyFile });

  // A pre-seeded reject rule with a rejectMessage: the failing call's
  // error must carry the rule's message, with no prompt consumed (the
  // scripted answers are already exhausted, so any prompt would throw).
  const rejectPolicyFile = join(dir, "reject-policy.json");
  writeFileSync(rejectPolicyFile, JSON.stringify({
    "myapp::exec": [{ action: "reject", rejectMessage: "Use safeBash instead" }],
  }));
  const rejected = await rejectMessageCase({ policyFile: rejectPolicyFile });

  writeFileSync("__result.json", JSON.stringify({
    result: result.data,
    remainingAnswers: answers.length,  // 0 = all consumed correctly
    rejectMessage: rejected.data,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
