import { foo } from "./agent.js";
import { writeFileSync } from "fs";

// Call 1: sleep 10s, don't mutate globalVar
// Call 2: sleep 5s, set globalVar to "mutated"
// Call 2 finishes first. If isolation works, call 1 still returns "unchanged".
const [result1, result2] = await Promise.all([foo(3, null), foo(1, "mutated")]);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      call1: result1.data,
      call2: result2.data,
    },
    null,
    2,
  ),
);
