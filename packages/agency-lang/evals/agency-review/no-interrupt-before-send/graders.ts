import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    "Agency code must raise an interrupt before any action that changes the outside world and cannot be undone, so the caller can approve or reject it. postComment sends a comment, which the assignment says cannot be unsent, and never raises an interrupt: it calls sendToServer directly, with no `raise comments::post(...)` before the call and no `raises <comments::post>` on the function. The caller gets no chance to stop the send.",
});
