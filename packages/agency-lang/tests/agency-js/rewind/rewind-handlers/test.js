import { main, rewindFrom } from "./agent.js";
import { writeFileSync } from "fs";

// Step 1: Run the agent, collect checkpoints.
// The agent will hit the interrupt after the LLM call.
// The outer handler approves it, so execution continues.
const checkpoints = [];
const result1 = await main("I feel terrible", {
  callbacks: {
    onCheckpoint(cp) {
      checkpoints.push(cp);
    },
  },
});

// Step 2: Rewind from the mood checkpoint with an override.
// After rewind, the interrupt should still be caught by the handlers
// (inner passes through, outer approves).
// If handlers aren't re-registered, the interrupt would propagate
// to the caller as an unhandled interrupt instead.
const rewound = await rewindFrom(checkpoints[0], { mood: "happy" });

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      // Original run: handlers were active, interrupt was handled
      originalMood: result1.data.mood,
      originalHandled: result1.data.result === true, // approve() returns true
      originalLog: result1.data.log,
      // Rewind: handlers should still be active
      rewoundMood: rewound.data.mood,
      rewoundHandled: rewound.data.result === true,
      rewoundLog: rewound.data.log,
    },
    null,
    2,
  ),
);
