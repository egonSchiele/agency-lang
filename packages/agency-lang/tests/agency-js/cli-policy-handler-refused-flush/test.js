import { main } from "./agent.js";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { safeDeleteDirectoryWithin } from "../../../dist/lib/utils.js";

const fixtureRoot = resolve(".");
const dir = resolve("test-output");
safeDeleteDirectoryWithin(fixtureRoot, dir);
mkdirSync(dir, { recursive: true });
const policyFile = join(dir, "policy.json");
writeFileSync(policyFile, "{}\n");

const answers = ["aa"];
const inputOverride = async () => {
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

let printed = "";
const realLog = console.log;
console.log = (...a) => {
  printed += a.join(" ") + "\n";
};

let result;
try {
  result = await main({ policyFile }, { inputOverride });
} finally {
  console.log = realLog;
}
const saved = readFileSync(policyFile, "utf8");
safeDeleteDirectoryWithin(fixtureRoot, dir);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: result.data,
      promptsLeft: answers.length,
      warnings: (printed.match(/could not save your new approval rules/g) || []).length,
      fileUnchanged: saved === "{}\n",
    },
    null,
    2,
  ),
);
