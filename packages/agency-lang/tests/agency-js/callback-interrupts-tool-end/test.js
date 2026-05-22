import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// `callback("onToolCallEnd")` fires inside a parallel tool branch AFTER
// the tool has already executed. Phase 1 + the b.interrupts gate fix
// mean:
//   - first pass: tool body runs ONCE, end-hook fires (count=1) and
//     interrupts; the surrounding branch bails. The downstream log step
//     and any further branch work is skipped (b.interrupts is set).
//   - resume: invoke step is skipped (idempotent — toolExecutions stays
//     at 1), end-hook re-fires (count=2, no interrupt) and sees the
//     restored toolResult, follow-up LLM call produces the final
//     answer.
//
// Coverage rationale (no statelog.log dependency):
//   - toolExecutions == 1 proves the tool body did NOT re-execute on
//     resume (the invoke b.step's idempotency).
//   - count == 2 proves the end-hook fired on first pass, bailed, and
//     re-fired on resume (the end b.step's resume-re-entry behavior).
//   - resumedResult == "hi" proves the restored toolResult is wired
//     through to the end-hook on the resume pass.
//   - tsEndCallCount asserts the TS-side onToolCallEnd callback runs
//     alongside the agency callback on every end-hook fire (callHook
//     batches all callbacks even when an earlier one interrupts), and
//     does so exactly the expected number of times across the
//     bail-and-resume cycle.
let tsEndCallCount = 0;
const callbacks = {
  onToolCallEnd: ({ toolName }) => {
    if (toolName === "greet") tsEndCallCount++;
  },
};

const initial = await main({ callbacks });

if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts from main(); got: ${JSON.stringify(initial.data)}`,
  );
}

// Each runNode / respondToInterrupts call creates a fresh execCtx, so
// the callbacks have to be re-attached on resume via `metadata.callbacks`
// (otherwise the TS-side callback only fires during the first pass).
const final = await respondToInterrupts(initial.data, [approve()], {
  metadata: { callbacks },
});

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      data: final.data,
      tsEndCallCount,
    },
    null,
    2,
  ),
);
