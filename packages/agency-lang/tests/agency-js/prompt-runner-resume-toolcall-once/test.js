import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// Regression test for tool-branch idempotency on resume.
//
// Scenario: on the FIRST pass, the tool runs to completion (success),
// the onToolCallEnd hook fires, the branch is fully done. Then the
// follow-up LLM call's onLLMCallStart (count==2) interrupts. On
// resume, `pr.parallel` re-enters the tool branch but every `b.step`
// inside it is already marked done — so none of the start/invoke/end
// /log steps re-execute. We observe that here by counting TS-side
// onToolCallEnd fires: if the end-step isn't wrapped in `b.step`, the
// hook would fire AGAIN on resume (count=2). Idempotent => count=1.
let tsEndCallCount = 0;
const callbacks = {
  onToolCallEnd: ({ toolName }) => {
    if (toolName === "greet") tsEndCallCount++;
  },
};

const initial = await main({ callbacks });

if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts on second LLM call; got: ${JSON.stringify(initial.data)}`,
  );
}

// Each runNode / respondToInterrupts call creates a fresh execCtx, so
// the TS callbacks must be re-attached on resume via `metadata.callbacks`
// (otherwise the TS-side callback wouldn't fire at all on resume — even
// when an unintended re-execution happens — and the regression would
// be silently swallowed).
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
