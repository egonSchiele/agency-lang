import { main, rewindFrom } from "./agent.js";
import { writeFileSync } from "fs";

// Step 1: Run the agent, collect checkpoints
const checkpoints1 = [];
await main("I feel terrible", {
  callbacks: {
    onCheckpoint(cp) {
      checkpoints1.push(cp);
    },
  },
});

// Step 2: Rewind from the first checkpoint (mood), collect new checkpoints
const checkpoints2 = [];
await rewindFrom(checkpoints1[0], { mood: "happy" }, {
  metadata: {
    callbacks: {
      onCheckpoint(cp) {
        checkpoints2.push(cp);
      },
    },
  },
});

// Step 3: Rewind from the second rewind's confidence checkpoint
const final = await rewindFrom(checkpoints2[0], { confidence: "high" });

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      checkpoints1Count: checkpoints1.length,
      checkpoints2Count: checkpoints2.length,
      finalResult: final.data,
    },
    null,
    2,
  ),
);
