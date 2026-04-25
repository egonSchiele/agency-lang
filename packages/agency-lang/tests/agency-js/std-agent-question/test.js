import { writeFileSync } from "fs";
import { ask, isInterrupt, resolveInterrupt } from "./agent.js";

const r = await ask("What is your favorite color?");
const interrupted = isInterrupt(r.data);
const resumed = interrupted
  ? await resolveInterrupt(r.data, "blue")
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
