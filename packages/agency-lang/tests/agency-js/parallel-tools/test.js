import { main } from "./agent.js";
import { writeFileSync } from "fs";

// Two slow tools (200ms each) are called in one LLM round. Under
// PromptRunner.parallel, both run concurrently, so both sit inside their
// sleep at the same moment and the agent's shared counter reaches 2. If the
// round ran them one after the other, the counter would never exceed 1.
//
// The agent reports that overlap itself rather than the test timing the
// call, so a slow or loaded CI runner cannot change the answer.
const result = await main();

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      data: result.data.data,
      ranInParallel: result.data.ranInParallel,
    },
    null,
    2,
  ),
);
