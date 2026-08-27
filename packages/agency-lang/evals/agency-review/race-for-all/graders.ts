import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    "fetchAll uses `race`, which returns the first finished fetch and cancels the others, so it returns one result instead of one per name in order; `fork` is the form that collects every result.",
});
