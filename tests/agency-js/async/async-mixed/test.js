import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
writeFileSync("__result.json", JSON.stringify({ data: result.data }, null, 2));
