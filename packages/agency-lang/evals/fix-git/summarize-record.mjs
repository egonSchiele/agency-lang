#!/usr/bin/env node
// Print a few facts from an eval-record produced by `agency eval extract`.
// This shows the statelog-based assertion idea: instead of reading the whole
// transcript, answer "what did the agent do?" from the structured record.
//
// usage: node summarize-record.mjs <eval-record.json>
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node summarize-record.mjs <eval-record.json>");
  process.exit(2);
}
const rec = JSON.parse(readFileSync(path, "utf8"));
const metrics = rec.metrics || {};
const events = rec.events || [];
const threads = rec.threads || [];

function usedAnyOf(patterns) {
  const re = new RegExp(patterns.join("|"), "i");
  return events.some(
    (e) => e.kind === "tool_start" && re.test(JSON.stringify(e.tool || "") + JSON.stringify(e.argsPreview || "")),
  );
}

console.log("llm calls:      ", metrics.llmCalls ?? "?");
console.log("tool counts:    ", JSON.stringify(metrics.toolCounts || {}));
console.log("threads:        ", threads.map((t) => t.label).filter(Boolean).join(", ") || "(none)");
console.log("ran git/shell:  ", usedAnyOf(["git", "bash", "shell", "exec"]));
console.log("used reflog/fsck:", usedAnyOf(["reflog", "fsck"]));
const out = rec.evalOutputs?.at(-1)?.value;
console.log("final reply:    ", typeof out === "string" ? out.slice(0, 200) : JSON.stringify(out)?.slice(0, 200));
