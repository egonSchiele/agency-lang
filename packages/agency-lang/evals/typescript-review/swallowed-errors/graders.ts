import { plantedFlawGraders } from "../lib/reviewGraders.js";

export default plantedFlawGraders({
  reason:
    "The catch block swallows the error: it neither logs nor rethrows, and the function then " +
    "returns the empty string as if it were a valid slug, so a failure is indistinguishable " +
    "from a title that slugifies to nothing. Callers can never find out why slugs went missing.",
});
