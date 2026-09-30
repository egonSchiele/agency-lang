import { primes } from "./agent.js";
import { writeFileSync } from "fs";
import { withoutReplyStats } from "../../helpers/withoutReplyStats.js";

const result = await primes();
console.log(result);
writeFileSync(
  "__result.json",
  JSON.stringify(
    // Token counts and costs change on every real run, so drop them.
    { data: withoutReplyStats(result.data) },
    null,
    2,
  ),
);
