import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-parse-"));
const policyFile = join(dir, "policy.json");
const missingFile = join(dir, "absent.json");
writeFileSync(policyFile, JSON.stringify({ "std::read": [{ action: "approve" }] }));

try {
  const result = await main({ policyFile, missingFile });
  writeFileSync("__result.json", JSON.stringify({ result: result.data }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
