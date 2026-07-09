import { main } from "./agent.js";
import { writeFileSync } from "fs";

// innerPingCount==1 means the forked subagent's inner tool loop inherited
// maxToolCallRounds=1 (second round blocked); ==2 would mean it fell back to
// the compiled default and the branch cap did not propagate to the fork.
const result = await main();
writeFileSync("__result.json", JSON.stringify({ data: result.data }, null, 2));
