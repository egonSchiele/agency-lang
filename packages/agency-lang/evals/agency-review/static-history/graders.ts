import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    "history is `static const`, and a static value is deeply immutable and shared by every run, so `history.push(...)` fails; a value that changes per run must be a plain `let`.",
});
