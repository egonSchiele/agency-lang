import { main } from "./agent.js";
import { writeFileSync } from "fs";

// Two slow tools (200ms each) are called in one LLM round. Under
// PromptRunner.parallel, both run concurrently, so total wall-clock for
// the tool round is ~200ms — not ~400ms as it would be if the round
// ran them sequentially.
const start = performance.now();
const result = await main();
const elapsed = performance.now() - start;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      data: result.data,
      // Use a coarse threshold to avoid CI flake. Sequential execution
      // would be > 400ms; the parallel path comfortably finishes in
      // < 350ms even on slow runners.
      ranInParallel: elapsed < 350,
    },
    null,
    2,
  ),
);
