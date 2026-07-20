import { writeFileSync } from "fs";
import { main, rewindFrom } from "./agent.js";
import { getMutable, resetMutable } from "../../helpers/mutableVar.js";

// Fresh run: checkpoint is taken BEFORE helper(), so helper() replays
// after a rewind. The callback lives in the imported mod.agency.
resetMutable();
const { data: checkpoint } = await main();
const freshFired = getMutable("imported-onFunctionStart-fired", false) === true;

// Rewind from the captured checkpoint. Reset the JS-side flag first so
// a hit can only come from the post-rewind helper() call.
resetMutable();
await rewindFrom(checkpoint, {});
const rewindFired = getMutable("imported-onFunctionStart-fired", false) === true;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      freshCallbackFired: freshFired,
      rewindCallbackFired: rewindFired,
    },
    null,
    2,
  ),
);
