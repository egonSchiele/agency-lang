import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    "`parseAmount(line) catch 0` replaces a failed parse with 0 and keeps going, so total never returns the failure or its message, and a bad line is silently counted as 0.",
});
