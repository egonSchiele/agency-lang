import { main } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// Durable-object-tag leak guard (plan Finding 1): a fork branch redact()s a
// plain object and returns it by reference. The parent posts statelog events
// containing that object AFTER the join (forkBranchEnd value, node result) —
// they must show [REDACTED], which only happens if the branch's durable-tag
// flag propagated to the parent's store when the branch settled.

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

await main();

const log = readFileSync("statelog.log", "utf-8");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      leaked: log.includes("sk-branch-secret"),
      redactedPresent: log.includes("[REDACTED]"),
    },
    null,
    2,
  ),
);
