import { flawedPlanGraders } from "../lib/reviewGraders.js";

export default flawedPlanGraders({
  reason:
    "The plan changes the built-in llm() function, which every program uses, to serve one router: a new " +
    "firstToolCall option that encodes a function call as a string name plus an untyped arguments object " +
    "and pretends the model replied with that tool call. That is a second way to call a function, which the " +
    "type checker cannot see and which goes around logging, cost accounting, and pause and resume. The " +
    "router should ask the decision model, match on its answer, and call the subagent as an ordinary " +
    "function. The problem the option works around, a handoff function called from code leaving its system " +
    "message on the caller's thread, belongs in the handoff call from code, and the existing expiring " +
    "system messages (docs/dev/runtime/expiring-messages.md) can remove that message.",
});
