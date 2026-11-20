import { approvedPlanGraders } from "../lib/reviewGraders.js";

export default approvedPlanGraders({
  approvedBecause:
    "safeBash already understands a cd on the left of &&. The spec extends that existing planning to a cd " +
    "followed by a newline or a semicolon, inside safeBash where the problem is, with no new mechanism and " +
    "no change to shared code outside safeBash.",
});
