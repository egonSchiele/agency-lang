import { main, rewindFrom } from "./agent.js";
import { writeFileSync } from "fs";

// Run the agent and collect checkpoints
const checkpoints = [];
const result = await main("I feel terrible", {
  callbacks: {
    onCheckpoint(cp) {
      checkpoints.push(cp);
    },
  },
});

// Rewind from the mood checkpoint, overriding mood to "happy"
const rewound = await rewindFrom(checkpoints[0], { mood: "happy" });

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      originalMoodIsString: typeof result.data === "string",
      rewoundMood: rewound.data,
    },
    null,
    2,
  ),
);
