import { idiomGraders } from "../lib/reviewGraders.js";

export default idiomGraders({
  reason:
    "the functions will be given to an LLM as tools, and each is described in a `//` comment above the def, which the LLM never sees; the description belongs in a docstring, the triple-quoted string that opens the function body, with an @param line per parameter.",
});
