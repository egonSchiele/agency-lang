import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    'the four settings are fields of an options object instead of named parameters with defaults, so `search("blue", order: "year")` and `search.partial(includeArchived: true)`, which the task requires, do not work.',
});
