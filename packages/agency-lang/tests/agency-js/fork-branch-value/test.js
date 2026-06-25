import { main } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// No LLM: the fork branches return plain values. Verify each
// forkBranchEnd event carries the branch's return value.

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const result = await main();

const events = readFileSync("statelog.log", "utf-8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

const forkBranchEnds = events.filter((e) => e.data?.type === "forkBranchEnd");
// Branches complete in nondeterministic order — sort the values.
const branchValues = forkBranchEnds.map((e) => e.data.value).sort((a, b) => a - b);
const allSuccess = forkBranchEnds.every((e) => e.data.outcome === "success");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: result.data,
      branchValues,
      count: forkBranchEnds.length,
      allSuccess,
    },
    null,
    2,
  ),
);
