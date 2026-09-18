import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-headless-value-"));
const policyFile = join(dir, "policy.json");

globalThis.__agencyInputOverride = async () => {
  throw new Error("Prompted in a non-interactive run");
};

try {
  const result = await main({ policyFile });
  const text = String(result.data);
  writeFileSync("__result.json", JSON.stringify({
    rejected: text.startsWith("failure:"),
    // The reason has to name the real cause. "No rule for this effect" is
    // false here — there is one, and it approves — and whoever read it
    // would go looking for a policy bug.
    saysARuleApproves: text.includes("a policy rule approves this effect"),
    doesNotClaimNoRule: !text.includes("has no rule for this effect"),
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
