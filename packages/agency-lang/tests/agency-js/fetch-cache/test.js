import { main, fromCode } from "./agent.js";
import { writeFileSync } from "fs";

const tool = await main();
const code = await fromCode();
writeFileSync("__result.json", JSON.stringify({ tool: tool.data, code: code.data }, null, 2));
