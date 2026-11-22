import { approvedPlanGraders } from "../lib/reviewGraders.js";

export default approvedPlanGraders({
  approvedBecause:
    "The session core already receives the text the user typed and already emits the reply, so it records " +
    "both in a list as they happen instead of working them out later from the model's thread. The list is " +
    "kept in the run's globals in a module of its own, the way the fetch cache keeps its state, so every " +
    "checkpoint saves it and a cancel, a resume, and a fork need no extra code. The transcript reader keeps " +
    "its signature, so its three callers do not change. The model's thread, the runtime, and the public " +
    "API are not changed, and the model is sent the same text as before.",
});
