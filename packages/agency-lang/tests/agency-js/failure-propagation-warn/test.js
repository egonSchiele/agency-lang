import { main } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// Warn mode must (a) leave behavior untouched and (b) emit the
// failurePropagation warn event to statelog. This is the end-to-end
// version of the spec's "statelog assertion for the skip event".

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const result = await main();
const log = readFileSync("statelog.log", "utf-8");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      legacyBehavior: result === "legacy: ran",
      warnEventLogged:
        log.includes('"type":"warn"') && log.includes("failurePropagation"),
    },
    null,
    2,
  ),
);
