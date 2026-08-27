import { idiomGraders } from "../lib/reviewGraders.js";

export default idiomGraders({
  reason:
    "every helper is a hand-written loop where the prelude already has the function: groupBy for the grouping, unique for the distinct extensions, count or a comprehension for the count, range(1, pages + 1) for the numbers, and extname from std::path instead of extOf.",
});
