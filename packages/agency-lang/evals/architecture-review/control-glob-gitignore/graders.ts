import { approvedPlanGraders } from "../lib/reviewGraders.js";

export default approvedPlanGraders({
  approvedBecause:
    "The tools disagreed: grep skipped ignored files and glob did not. The spec brings glob and recursive ls " +
    "in line with grep: glob gets the same respectGitignore parameter grep already has, and the change reuses " +
    "the existing directory walk and the existing ignoredFromAbove check in lib/stdlib/gitignore.ts instead " +
    "of adding a new mechanism.",
});
