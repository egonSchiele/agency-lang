import { writeFileSync } from "fs";
import { main } from "./agent.js";
import { resetMutable } from "../../helpers/mutableVar.js";

resetMutable();

// Three sequential runs in the SAME process. With PR 3's static-bare-
// statement support:
//   - `static logEvent("startup")` runs once → startupCount stays 1.
//   - `logEvent("run")` runs every time → runCount increments per call.
//
// (`agent.js`'s `main()` returns the current counts as observed *inside*
// the node after globals have been initialized for that run.)
const r1 = await main();
const r2 = await main();
const r3 = await main();

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      run1: r1.data,
      run2: r2.data,
      run3: r3.data,
    },
    null,
    2,
  ),
);
