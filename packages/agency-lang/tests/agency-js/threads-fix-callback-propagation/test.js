import { writeFileSync } from "fs";
import { main } from "./agent.js";
import { getMutable, resetMutable } from "../../helpers/mutableVar.js";

resetMutable();
await main();

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      importedCallbackFired: getMutable("imported-onThreadEnd-fired", false) === true,
      threadId: getMutable("imported-onThreadEnd-thread-id", null),
    },
    null,
    2,
  ),
);
