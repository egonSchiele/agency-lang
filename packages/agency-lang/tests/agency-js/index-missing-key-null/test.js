import { lookups } from "./agent.js";
import { writeFileSync } from "fs";

const r = (await lookups()).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      missingKeyIsNull: r.missingKey === null,
      outOfBoundsIsNull: r.outOfBounds === null,
      negativeIndexIsNull: r.negativeIndex === null,
      presentKeyValue: r.presentKey,
      inBoundsValue: r.inBounds,
      falsyZeroPreserved: r.falsyZero === 0,
    },
    null,
    2,
  ),
);
