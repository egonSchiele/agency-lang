import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cli-policy-parallel-reject-"));
const policyFile = join(dir, "policy.json");

// "rr" is reject always, and it is the only answer scripted. A sibling
// that prompted again would ask for one that is not here.
const answers = ["rr"];
globalThis.__agencyInputOverride = async () => {
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

let printed = "";
const realLog = console.log;
console.log = (...args) => { printed += args.join(" ") + "\n"; };

let approved;
try {
  const result = await main({ policyFile });
  approved = result.data;
} finally {
  console.log = realLog;
  rmSync(dir, { recursive: true, force: true });
}

const plain = printed.replace(/\x1b\[[\d;]*m/g, "");

writeFileSync("__result.json", JSON.stringify({
  // None of the three got past its interrupt.
  approved,
  remainingAnswers: answers.length,
  // The other two are told why no prompt appeared for them, rather than
  // failing silently.
  rejectionsPrinted: (plain.match(/Policy rejected myapp::deploy/g) || []).length,
}, null, 2));
