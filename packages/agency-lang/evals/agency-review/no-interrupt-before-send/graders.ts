import { plantedBugGraders } from "../lib/reviewGraders.js";

export default plantedBugGraders({
  reason:
    "postComment calls sendToServer, which cannot be undone, without raising a named interrupt first (raise comments::post(...) with raises <comments::post>), so nothing can approve or reject the send.",
});
