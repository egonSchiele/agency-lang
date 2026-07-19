import { writeFileSync } from "fs";

// Capture everything printed before the agency module loads, so the
// ASKED/READ lines from both fork branches are countable. Prints are the
// only cross-branch observable: handler counter writes land in the
// raising branch's isolated state and vanish at the join.
const lines = [];
const originalLog = console.log;
console.log = (...parts) => {
  lines.push(parts.join(" "));
  originalLog(...parts);
};

const { runForkIsolation } = await import("./agent.js");
const result = await runForkIsolation();
console.log = originalLog;

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
