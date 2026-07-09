import { main } from "./agent.js";
import { writeFileSync } from "fs";

// pingCount after the run: 1 means the second tool round was blocked by
// maxToolCallRounds=1; 2 would mean the branch-default override was ignored.
const result = await main();
writeFileSync("__result.json", JSON.stringify({ data: result.data }, null, 2));
