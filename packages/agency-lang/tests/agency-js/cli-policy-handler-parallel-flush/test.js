import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "internalio-"));
const policyFile = join(dir, "policy.json");
writeFileSync(policyFile, JSON.stringify({ "myapp::other": [{ action: "reject" }] }));

const answers = ["aa"];
globalThis.__agencyInputOverride = async () => {
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
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

const rejections = (printed.match(/Policy rejected myapp::other/g) || []).length;
writeFileSync("__result.json", JSON.stringify({
  // The same window as cli-policy-handler-parallel-rule, but the write
  // half: the first branch of round two flushes the rule round one
  // saved, and the other two are in the handler while it does.
  rejections,
}, null, 2));
