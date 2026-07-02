import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync, rmSync } from "fs";

rmSync("child-statelog.jsonl", { force: true });

const first = await main();
if (!hasInterrupts(first.data)) {
  writeFileSync("__result.json", JSON.stringify({
    error: "expected surfaced interrupt, got: " + JSON.stringify(first.data),
  }));
  process.exit(0);
}

const surfaced = first.data;
const resumed = await respondToInterrupts(surfaced, surfaced.map(() => approve()));

// The child wrote statelog JSONL across BOTH execution segments (pause +
// resume). Assertions:
//  - one trace_id across all segments (runId persists across pause/resume)
//  - that trace_id is the inherited runId (== the surfaced interrupt's)
// Span adoption (parent_span_id rooting) is unit-tested in
// statelogClient.test.ts — this parent runs with observability off, so it
// has no live span for the child to adopt.
const lines = readFileSync("child-statelog.jsonl", "utf-8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
rmSync("child-statelog.jsonl", { force: true });

const traceIds = lines
  .map((l) => l.trace_id)
  .filter((id, i, all) => all.indexOf(id) === i);

// The resumed child re-enters respondToInterrupts with the same preserved
// interrupt ids; its user-resolution emission is suppressed (the root's is
// the single terminal event), so the child log must contain none.
const childUserResolutions = lines.filter(
  (l) => l.data.type === "interruptResolved" && l.data.resolvedBy === "user",
).length;

writeFileSync("__result.json", JSON.stringify({
  finalData: resumed.data,
  oneTraceId: traceIds.length === 1,
  traceMatchesInterruptRunId: traceIds[0] === surfaced[0].runId,
  noDuplicateUserResolutions: childUserResolutions === 0,
}, null, 2));
