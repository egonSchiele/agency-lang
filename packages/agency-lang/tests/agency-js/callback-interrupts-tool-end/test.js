import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";

// Start from a clean statelog so the preResume read isn't polluted by
// the previous run's events. The test runner does not truncate
// statelog.log between runs.
if (existsSync("statelog.log")) unlinkSync("statelog.log");

// `callback("onToolCallEnd")` fires inside a parallel tool branch AFTER
// the tool has already executed. Phase 1 + the b.interrupts gate fix
// (commit 52c00967) mean:
//   - first pass: tool runs once (toolExecutions=1), end-hook bails,
//     statelog `toolCall` event is NOT emitted (gated on b.interrupts)
//   - resume: invoke step is skipped (idempotent), end-hook re-fires
//     (count=2, no interrupt), tool does NOT re-execute
//     (toolExecutions stays at 1), follow-up LLM call produces the
//     final answer.
const initial = await main();

if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts from main(); got: ${JSON.stringify(initial.data)}`,
  );
}

// Before resume: read the statelog and assert toolCall was NOT logged.
// This is the b.interrupts-gate regression: without it, the toolCall
// event would appear here AND again after resume.
let preResumeToolCalls = 0;
if (existsSync("statelog.log")) {
  const lines = readFileSync("statelog.log", "utf8")
    .split("\n")
    .filter(Boolean);
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (ev?.data?.type === "toolCall") preResumeToolCalls++;
  }
}

const final = await respondToInterrupts(initial.data, [approve()]);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      data: final.data,
      preResumeToolCalls,
    },
    null,
    2,
  ),
);
