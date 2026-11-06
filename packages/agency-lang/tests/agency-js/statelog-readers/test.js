import { work, inspect, refused } from "./agent.js";
import { unlinkSync } from "fs";
import { writeFileSync } from "fs";
import * as path from "path";

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

// Longer than the 100-character cap, so logRow has to cut its user row.
const QUESTION =
  "Please look up the zephyrine notes and tell me what they say. " +
  "I need the whole summary, with every detail the notes hold, because the " +
  "meeting tomorrow depends on it and nobody else has read them yet.";

await work(QUESTION);
await work(QUESTION);
const inspected = (await inspect("zephyrine")).data;
const rejected = (await refused()).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      failed: inspected.failed ?? null,
      atLeastTwoTraces: inspected.traceCount >= 2,
      workTraces: inspected.workTraces,
      toolCalls: inspected.toolCalls,
      outlineHasToolRow: inspected.toolRows > 0,
      searchMatched: inspected.searchMatched > 0,
      rowAddressMatches: inspected.rowAddressMatches,
      rowTruncated: inspected.rowTruncated,
      rowFitsCap: inspected.rowLength <= 100,
      payloadFilenames: [...new Set(inspected.filenames)],
      payloadDirIsAbsolute: inspected.dirs.length === 4 && inspected.dirs.every((dir) => path.isAbsolute(dir)),
      rejectedReadFailed: rejected,
    },
    null,
    2,
  ),
);
