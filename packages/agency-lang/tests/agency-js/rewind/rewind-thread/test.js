import { main, rewindFrom } from "./agent.js";
import { writeFileSync } from "fs";

// Run the agent and collect checkpoints + LLM call info
const checkpoints = [];
const llmCalls = [];
await main("I feel terrible", {
  callbacks: {
    onCheckpoint(cp) {
      checkpoints.push(cp);
    },
    onLLMCallStart({ prompt, messages }) {
      llmCalls.push({ prompt, messages: [...messages] });
    },
  },
});

// Rewind from the mood checkpoint, overriding mood to "happy"
const rewindLlmCalls = [];
const rewound = await rewindFrom(checkpoints[0], { mood: "happy" }, {
  metadata: {
    callbacks: {
      onLLMCallStart({ prompt, messages }) {
        rewindLlmCalls.push({ prompt, messages: [...messages] });
      },
    },
  },
});

// During the rewind, only the second LLM call should run (the first was skipped).
// Its prompt should reference "happy" (the overridden value).
const rewindCall = rewindLlmCalls[0];

// The thread history sent to the second LLM call includes messages
// from the first call. Check whether the original assistant response
// (which said "sad" or similar) is still in the thread history.
const threadMessages = rewindCall?.messages || [];
const assistantMessages = threadMessages.filter((m) => m.role === "assistant");
const originalAssistantContent = JSON.stringify(assistantMessages[0]?.content || "");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      // The prompt for the second LLM call uses the overridden mood
      rewindPromptContainsHappy: rewindCall?.prompt?.includes("happy"),
      // Thread history: the first assistant message still has the original
      // response (not updated by the override)
      threadHasOriginalResponse: !originalAssistantContent.includes("happy"),
      // The rewound result uses the overridden value for mood
      rewoundMood: rewound.data.mood,
      // The response should echo "happy" since the prompt asks for it
      rewoundResponseContainsHappy: rewound.data.response?.toLowerCase().includes("happy"),
    },
    null,
    2,
  ),
);
