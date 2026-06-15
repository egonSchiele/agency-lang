import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-array-"));
const policyFile = join(dir, "policy.json");

// "r" picks reject at the menu; "" skips the reject-reason follow-up.
const answers = ["r", ""];
globalThis.__agencyInputOverride = async () => {
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

try {
  const result = await main({ policyFile });
  const asText = JSON.stringify(result.data);
  writeFileSync("__result.json", JSON.stringify({
    // The bug surfaced as a render exception while drawing the prompt.
    crashedOnRender: asText.includes("content.split"),
    rejected: asText.includes("interrupt rejected"),
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
