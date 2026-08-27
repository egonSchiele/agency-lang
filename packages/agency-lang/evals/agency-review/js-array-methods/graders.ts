import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    "the code calls JavaScript array methods with callbacks (.filter, .sort, .map, .reduce), which Agency does not support: " +
    "they typecheck and then crash at run time. Agency code uses list comprehensions or the stdlib functions " +
    "(filter, map, sortBy, reduce) with a block.",
});
