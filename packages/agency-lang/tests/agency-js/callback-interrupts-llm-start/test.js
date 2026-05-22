import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

// A top-level `callback("onLLMCallStart")` interrupts on the first fire.
// Companion to ../callback-interrupts (which covers onLLMCallEnd).
// `onLLMCallStart` fires BEFORE the LLM call; bailing here means the LLM
// is not invoked at all on the first pass. On resume the step body
// re-runs, the callback re-fires (count=2, no interrupt), and the LLM
// runs once.
// With Phase 1 of the prompt-runner work, callHook inside `_runPrompt`
// returns the Interrupt[]; PromptRunner.step snapshots messages, stamps
// a pinned checkpoint, and PromptBailout makes `runPrompt` return the
// interrupts up the stack. The compiled `llm()` site halts main() with
// the interrupts and we surface them to the JS caller.
const initial = await main();

if (!hasInterrupts(initial.data)) {
  throw new Error(
    `Expected interrupts from main(); got: ${JSON.stringify(initial.data)}`,
  );
}

// Approve the interrupt — resume re-enters runPrompt, the initialLlmCall
// step re-runs, the deterministic LLM mock returns the same response,
// the callback re-fires (count becomes 2 because callback bodies re-run
// from the top), this time count != 1 so no interrupt, runPrompt returns
// cleanly, main() returns its final value.
const final = await respondToInterrupts(initial.data, [approve()]);

writeFileSync(
  "__result.json",
  JSON.stringify({ data: final.data }, null, 2),
);
