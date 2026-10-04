import { main } from "./agent.js";
import { writeFileSync } from "fs";

// Two runs of one node, started together. Each calls a TypeScript helper
// that waits and then charges a cost. The slow run charges 1 and the fast
// run charges 2, so the fast run's helper wakes up while the slow run is
// still waiting.
//
// Each run must see only its own charge. A run that saw 3, or the other
// run's amount, read another run's state.
const [slow, fast] = await Promise.all([main(1, 60), main(2, 5)]);

writeFileSync(
  "__result.json",
  JSON.stringify({ slow: slow.data, fast: fast.data }, null, 2),
);
