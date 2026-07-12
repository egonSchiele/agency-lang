import { lookups, optChainNoThrow } from "./agent.js";
import { writeFileSync } from "fs";

const r = (await lookups()).data;

// Must not throw. With per-element wrapping this call crashes (null["y"]);
// with terminal-only wrapping `deep` is null and this resolves cleanly.
const opt = (await optChainNoThrow()).data;

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
      optChainDeepIsNull: opt.deep === null,
      // optional-terminal index on null stays undefined (not normalized) → dropped from JSON
      optNullIndexIsUndefined: opt.optNull === undefined,
    },
    null,
    2,
  ),
);
