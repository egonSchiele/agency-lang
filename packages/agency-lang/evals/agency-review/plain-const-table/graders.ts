import { idiomGraders } from "../lib/reviewGraders.js";

export default idiomGraders({
  reason:
    "RATES never changes for the life of the program, so it should be `static const`, initialized once and shared across runs, instead of a plain `const` global that every run rebuilds; history is rightly a plain `let`.",
});
