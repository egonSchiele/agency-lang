import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
const data = result.data.sort();
writeFileSync("__result.json", JSON.stringify({ data }, null, 2));
