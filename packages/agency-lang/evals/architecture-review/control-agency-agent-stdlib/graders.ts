import { approvedPlanGraders } from "../lib/reviewGraders.js";

export default approvedPlanGraders({
  approvedBecause:
    "The revision keeps CLI behavior in the CLI: it deletes the one-shot modes and their setters from the " +
    "library function, treats the agent as interactive, and gives callers one extraTools parameter for any " +
    "extra tools, instead of a parameter or setting per feature.",
});
