import { writeFileSync } from "fs";
import { ask, resolveInterrupt } from "./agent.js";

const r = await ask("What is your favorite color?");
const resumed = await resolveInterrupt(r.data, "blue");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      interrupted: r.isInterrupt === true || r.data?.success === undefined,
      resumedValue: resumed.data,
    },
    null,
    2,
  ),
);
