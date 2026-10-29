import { main } from "./agent.js";
import { writeFileSync } from "fs";

const refused = await main({ noteTitle: 5 });
const accepted = await main({ noteTitle: "Groceries 2026" });

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalData: {
        refusedSucceeded: refused.data.success,
        refusalNamesTheArgument: String(refused.data.error ?? "").startsWith(
          'Argument "inputs" of main',
        ),
        accepted: accepted.data,
      },
    },
    null,
    2,
  ),
);
