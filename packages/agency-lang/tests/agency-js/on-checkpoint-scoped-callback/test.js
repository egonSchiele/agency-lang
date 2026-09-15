import { main, resumeFromCheckpoint } from "./agent.js";
import { bumpCount, reset } from "./counter.js";
import { writeFileSync } from "fs";

const seen = [];
const callbacks = {
  onCheckpoint: (event) => seen.push({ ...event, bumpsBefore: bumpCount() }),
};

reset();
const first = await main({ callbacks });
const bumpsAfterFresh = bumpCount();

// A frame holding a scoped callback still serializes to plain JSON: a
// stringify round trip changes nothing.
const everyPayloadPlainJson = seen.every(
  (event) =>
    JSON.stringify(JSON.parse(JSON.stringify(event.checkpoint))) ===
    JSON.stringify(event.checkpoint),
);

// Resume from the checkpoint at the statement that calls helper(), stored as
// text the way a host would. The scoped onFunctionStart callback in that
// frame comes back from its function ref and fires again.
const stored = [...seen].reverse().find((event) => event.bumpsBefore === 0);
const resumed = await resumeFromCheckpoint(
  { type: "paused", checkpoint: JSON.parse(JSON.stringify(stored.checkpoint)), runId: stored.runId },
  { metadata: { callbacks } },
);
const bumpsAfterResume = bumpCount();

writeFileSync(
  "__result.json",
  JSON.stringify(
    { first: first.data, bumpsAfterFresh, everyPayloadPlainJson, resumed: resumed.data, bumpsAfterResume },
    null,
    2,
  ),
);
