import { deferred, ruleDecides, takesGivenPolicy } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-deferred-"));
const policyFile = join(dir, "policy.json");

// Any prompt is the bug under test: a deferred interrupt is not asked about.
const inputOverride = async () => {
  throw new Error("Prompted while undecided interrupts are deferred");
};

try {
  const left = await deferred({ policyFile }, { inputOverride });
  const interrupts = Array.isArray(left.data) ? left.data : [];
  const decided = await ruleDecides({ policyFile }, { inputOverride });
  const given = await takesGivenPolicy({ policyFile }, { inputOverride });
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        leftTheRun: interrupts.map((interrupt) => interrupt.effect),
        carriesACheckpoint: interrupts.every((interrupt) => interrupt.checkpoint != null),
        ruleDecides: String(decided.data),
        givenPolicyRejects: String(given.data).startsWith("failure:"),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
