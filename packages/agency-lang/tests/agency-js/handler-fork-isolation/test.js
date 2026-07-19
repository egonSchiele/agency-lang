import { writeFileSync } from "fs";
import { runForkIsolation } from "./agent.js";

// Capture everything printed while the fork runs, so the ASKED/READ
// lines from both branches are countable. Prints are the only
// cross-branch observable: handler counter writes land in the raising
// branch's isolated state and vanish at the join. The prints happen at
// call time, not module init, so a static import is fine.
const lines = [];
const originalLog = console.log;
console.log = (...parts) => {
  lines.push(parts.join(" "));
  originalLog(...parts);
};

let result;
try {
  result = await runForkIsolation();
} finally {
  console.log = originalLog;
}

const count = (needle) => lines.filter((line) => line.includes(needle)).length;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      result: result.data,
      askedA: count("ASKED A"),
      askedB: count("ASKED B"),
      readsRejected: count("rejected"),
    },
    null,
    2,
  ),
);
