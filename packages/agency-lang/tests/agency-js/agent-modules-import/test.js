import { writeFileSync } from "fs";
import { main } from "./agent.js";

const result = await main();

writeFileSync("__result.json", JSON.stringify(result.data, null, 2));
