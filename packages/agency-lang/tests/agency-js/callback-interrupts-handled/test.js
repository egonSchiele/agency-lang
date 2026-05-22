import { main, hasInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// Regression test: a top-level callback that throws an interrupt should
// be caught by a `handle` block on the active call stack at the firing
// site — exactly the way it worked before the prompt-runner changes.
// The compiled `llm()` call site re-throws the interrupts coming back
// from runPrompt; the handler approves them; llm() resumes and returns
// its actual value. The JS caller never sees an interrupt.
const result = await main();

if (hasInterrupts(result.data)) {
  throw new Error(
    `Expected handler to catch all interrupts; instead got: ${JSON.stringify(result.data)}`,
  );
}

writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data }, null, 2),
);
