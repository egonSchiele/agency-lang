// Generated shape: the diff below is expected/diff.patch and the reason is
// expected/reason.txt, embedded so the grader bundle stays self-contained
// when the run directory snapshots it.
import { mutantGraders } from "../lib/reviewGraders.js";

export default mutantGraders({
  reason:
    "a copy-paste bug: the above-range branch returns low instead of high, so a value above " +
    "the range clamps to the bottom of the range instead of the top.",
  diff: `@@ -3,7 +3,7 @@
     return low
   }
   if (value > high) {
-    return high
+    return low
   }
   return value
 }`,
});
