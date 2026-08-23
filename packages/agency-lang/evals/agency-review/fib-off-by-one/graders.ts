import { plantedBugGraders } from "../lib/reviewGraders";

export default plantedBugGraders({
  reason:
    "fib(0) returns 1 instead of 0: the base case for n = 0 is wrong (the code returns 1 " +
    "for every n <= 1, but the assignment defines fib(0) = 0).",
});
