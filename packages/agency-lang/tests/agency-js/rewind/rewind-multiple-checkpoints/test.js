import { main } from "./agent.js";
import { writeFileSync } from "fs";

const checkpoints = [];

await main("I feel great!", {
  callbacks: {
    onCheckpoint(cp) {
      checkpoints.push(cp);
    },
  },
});

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      checkpointCount: checkpoints.length,
      targetVariables: checkpoints.map((cp) => cp.llmCall.targetVariable),
    },
    null,
    2,
  ),
);
