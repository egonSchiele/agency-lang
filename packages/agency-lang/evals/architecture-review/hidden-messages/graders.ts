import { flawedPlanGraders } from "../lib/reviewGraders.js";

export default flawedPlanGraders({
  reason:
    "The problem is a display problem: a reopened session shows text the user never typed. The plan fixes " +
    "it by changing the conversation the model reads, so the saved thread can double as the display. It " +
    "adds a hidden key to messages, a rule in the runtime's push that hides a user message pushed during a " +
    "handoff, and a hidden parameter on the public userMessage function, and it splits notes and subagent " +
    "context into messages of their own, which changes what the model is sent. Marking what to leave out " +
    "also fails in the unsafe direction: a source nobody marked is shown as the user's words, and the plan " +
    "already misses some, such as the compaction summary. The session core is the one place that knows " +
    "what the user typed and what the agent replied. It should record those two values in a list of its " +
    "own, kept in the run's state so every checkpoint saves it, and the transcript reader should show that " +
    "list. The model's thread, the runtime, and the public API then need no change.",
});
