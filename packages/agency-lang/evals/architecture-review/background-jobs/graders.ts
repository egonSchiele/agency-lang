import { flawedPlanGraders } from "../lib/reviewGraders.js";

export default flawedPlanGraders({
  reason:
    "resumeJob raises the job's pending interrupts again in the parent, at the resumeJob line, so the " +
    "handlers that happen to surround that call answer them. Those handlers were written for the parent's " +
    "own code and may have nothing to do with what the child asked, so they could approve or reject the " +
    "child's interrupts on the wrong basis. When a parked job is resumed, its pending interrupts should be " +
    "shown to the user for an answer, not handed to the handlers around the resume call. The design should " +
    "read the pending interrupts' data and resume the child from its checkpoint with the user's answers, " +
    "rather than re-raising the interrupts.",
});
