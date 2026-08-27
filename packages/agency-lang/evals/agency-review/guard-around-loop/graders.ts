import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    'the 500 ms guard wraps the whole loop instead of each summarize call, so one slow document trips the budget for all of them and every entry becomes "timed out", when the task says the other documents must still be summarized.',
});
