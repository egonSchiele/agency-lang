import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "internalio-"));
const policyFile = join(dir, "policy.json");
writeFileSync(
  policyFile,
  JSON.stringify({
    "myapp::deploy": [{ action: "reject", rejectMessage: "deploys are frozen" }],
  }),
);

globalThis.__agencyInputOverride = async () => {
  throw new Error("Unexpected prompt: the policy decides every interrupt");
};

let printed = "";
const realLog = console.log;
console.log = (...a) => { printed += a.join(" ") + "\n"; };

try {
  await main({ policyFile });
} finally {
  console.log = realLog;
  rmSync(dir, { recursive: true, force: true });
}

const rejections = (printed.match(/Policy rejected myapp::deploy/g) || []).length;
writeFileSync("__result.json", JSON.stringify({
  // One rule in the file decides all three, and the first branch reads
  // that file while the other two are already in the handler. Two
  // rejections here instead of three would mean a branch had slipped
  // through the window where the handler approves its own file reads.
  rejections,
}, null, 2));
