import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-headless-"));
const policyFile = join(dir, "policy.json");

// Any prompt is the bug under test: a headless run has no one to answer.
globalThis.__agencyInputOverride = async () => {
  throw new Error("Prompted in a non-interactive run");
};

try {
  const result = await main({ policyFile });
  const text = String(result.data);
  writeFileSync("__result.json", JSON.stringify({
    rejected: text.startsWith("failure:"),
    reasonNamesEffect: text.includes("myapp::secret"),
    reasonExplains: text.includes("rejected automatically"),
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
