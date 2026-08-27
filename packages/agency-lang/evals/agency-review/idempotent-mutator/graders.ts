import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    "addTask is marked `idempotent` although every call appends a task, so a caller or an automated retry that trusts the marker will add duplicates; only listOpenTasks is safe to re-run.",
});
