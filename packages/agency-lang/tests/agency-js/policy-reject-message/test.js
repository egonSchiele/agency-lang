import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-reject-message-"));
const policyFile = join(dir, "policy.json");

// Any prompt is a bug: the reject rule must decide without asking.
globalThis.__agencyInputOverride = async () => {
  throw new Error("Unexpected input() call: the reject rule should decide without prompting");
};

try {
  writeFileSync(
    policyFile,
    JSON.stringify({
      "myapp::exec": [{ action: "reject", rejectMessage: "Use safeBash instead" }],
    }),
  );
  const rejected = await main({ policyFile });
  writeFileSync("__result.json", JSON.stringify({ rejectMessage: rejected.data }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
