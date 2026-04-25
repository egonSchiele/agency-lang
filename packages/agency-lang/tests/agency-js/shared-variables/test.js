import { foo } from "./agent.js";
import { writeFileSync } from "fs";

// Call 1: don't mutate globalVar
// Call 2: mutate globalVar to "mutated"
// Both should see the same sharedVar, but different globalVar values.
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
