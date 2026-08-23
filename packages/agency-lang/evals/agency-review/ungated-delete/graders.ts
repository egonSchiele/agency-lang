import { plantedBugGraders } from "../lib/reviewGraders";

export default plantedBugGraders({
  reason:
    "remove is called with `with approve`, which approves the destructive deletion inside " +
    "the program, when the assignment requires leaving that approval to the caller's handler.",
});
