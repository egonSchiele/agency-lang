import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
const tools = result.data;

writeFileSync("__result.json", JSON.stringify({
  toolCount: tools.length,
  firstToolName: tools[0]?.name,
}, null, 2));
