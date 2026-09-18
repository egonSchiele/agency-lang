import { main } from "./agent.js";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-code-diffs-late-"));
const policyFile = join(dir, "policy.json");

// One answer for two edits. The second is decided by the rule this one
// saves, so it must not ask.
const answers = ["aa"];
let prompts = 0;
globalThis.__agencyInputOverride = async () => {
  prompts += 1;
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

let printed = "";
const realLog = console.log;
console.log = (...args) => { printed += args.join(" ") + "\n"; };

try {
  await main({ policyFile });
} finally {
  console.log = realLog;
  rmSync(dir, { recursive: true, force: true });
}

const plain = printed.replace(/\x1b\[[\d;]*m/g, "");

writeFileSync("__result.json", JSON.stringify({
  prompts,
  // Both edits show their diff: the one that was asked about, and the one
  // the just-saved rule decided while it waited.
  diffsPrinted: (plain.match(/⏺ Edit: /g) || []).length,
  askedOneShown: plain.includes("ONE"),
  lateOneShown: plain.includes("TWO"),
  // The late one says why no prompt appeared for it.
  saidJustSaved: plain.includes("by the rule just saved"),
}, null, 2));
