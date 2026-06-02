import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "ui-policy-"));
const policyFile = join(dir, "policy.json");

// No active REPL → `_routePrompt` falls back to raw `input()`, which
// honours `__agencyInputOverride`. The override returning "a" approves
// the single interrupt and the handler returns without further prompts.
let promptedRaw = false;
globalThis.__agencyInputOverride = async () => {
  promptedRaw = true;
  return "a";
};

try {
  const result = await main({ policyFile });
  writeFileSync(
    "__result.json",
    JSON.stringify({ result: result.data, promptedRaw }, null, 2),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
