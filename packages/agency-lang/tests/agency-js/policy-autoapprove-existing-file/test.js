import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-autoapprove-"));
const policyFile = join(dir, "policy.json");

// Any input() means a prompt fired — i.e. the policy did NOT auto-approve.
let prompted = false;
const inputOverride = async () => {
  prompted = true;
  throw new Error("unexpected prompt: read was not auto-approved");
};

try {
  const result = await main({ policyFile }, { inputOverride });
  writeFileSync("__result.json", JSON.stringify({
    result: result.data,
    prompted,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
