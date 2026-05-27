import { main } from "./agent.js";
import { calls } from "./helpers.js";
import { writeFileSync } from "fs";

const result = await main("order-42");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: result.data,
      calls,
    },
    null,
    2,
  ),
);
