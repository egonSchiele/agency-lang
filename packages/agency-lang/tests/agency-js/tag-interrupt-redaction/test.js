import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// Redaction must survive a REAL interrupt/resume: the checkpoint serializes
// the state stack (destroying the tagged object's identity) and the globals
// store (carrying the durable-tag gate flag); resume revives both from JSON.
// The resumed run returns the object, so post-resume statelog events
// (node result, agentEnd) leak unless the revived copy still carries its tag
// AND the revived store still trips the hasAnyTags() gate.

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const result = await main();

if (!hasInterrupts(result.data)) {
  throw new Error("Expected an interrupt");
}

const finalResult = await respondToInterrupts(result.data, [approve()]);

const log = readFileSync("statelog.log", "utf-8");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      leaked: log.includes("sk-resume-secret"),
      redactedPresent: log.includes("[REDACTED]"),
      // The RETURN VALUE keeps the real data — redaction is statelog-only.
      valueIntact: finalResult.data?.apiKey === "sk-resume-secret",
    },
    null,
    2,
  ),
);
