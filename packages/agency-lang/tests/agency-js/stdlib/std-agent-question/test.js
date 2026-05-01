import { writeFileSync } from "fs";
import { ask, hasInterrupts, approve, respondToInterrupts } from "./agent.js";

const r = await ask("What is your favorite color?");
const interrupted = hasInterrupts(r.data);
const resumed = interrupted
  ? await respondToInterrupts(r.data, [approve("blue")], { overrides: { color: "blue" } })
  : { data: undefined };

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      interrupted,
      resumedValue: resumed.data,
    },
    null,
    2,
  ),
);
