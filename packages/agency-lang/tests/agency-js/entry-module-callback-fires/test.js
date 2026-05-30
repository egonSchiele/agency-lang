import { writeFileSync } from "fs";
import { main } from "./agent.js";
import { getMutable, resetMutable } from "../../helpers/mutableVar.js";

resetMutable();
await main();

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      entryCallbackFired: getMutable("entry-onThreadEnd-fired", false) === true,
      threadId: getMutable("entry-onThreadEnd-thread-id", null),
    },
    null,
    2,
  ),
);
