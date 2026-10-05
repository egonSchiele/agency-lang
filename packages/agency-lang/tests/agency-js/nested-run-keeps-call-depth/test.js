import { main } from "./agent.js";
import { writeFileSync } from "fs";

// `main` calls the function `outerCall`, which is one call deep. `outerCall`
// calls a helper that starts the node `inner` as a new run. `inner` calls
// the function `innerCall`, which reports how deep it is.
//
// The inner run was started from inside the outer one, so it carries on
// counting: `innerCall` is two calls deep. A depth of 1 means the inner run
// started a count of its own, and a helper that starts a node which calls
// the helper again would never reach maxCallDepth.
const result = await main();

writeFileSync("__result.json", JSON.stringify({ depthInInnerRun: result.data }, null, 2));
