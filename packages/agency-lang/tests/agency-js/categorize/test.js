import { categorize } from "./agent.js";
import { writeFileSync } from "fs";

const result1 = await categorize("Remind me to buy milk");
const result2 = await categorize("Add eggs to my shopping list");

writeFileSync(
  "__result.json",
  JSON.stringify({ first: result1.data, second: result2.data }, null, 2),
);
