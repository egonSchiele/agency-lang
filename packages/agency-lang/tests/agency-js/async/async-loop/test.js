import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
const data = {
  results: result.data.results,
  logSorted: result.data.log.sort((a, b) => a - b),
};
writeFileSync("__result.json", JSON.stringify({ data }, null, 2));
