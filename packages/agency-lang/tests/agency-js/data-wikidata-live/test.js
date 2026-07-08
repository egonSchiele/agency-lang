import { liveSearch } from "./agent.js";
import { writeFileSync } from "node:fs";

// Opt-in: only hits the live Wikidata API when AGENCY_LIVE_TESTS is set.
if (!process.env.AGENCY_LIVE_TESTS) {
  writeFileSync("__result.json", JSON.stringify({ skipped: true }, null, 2));
} else {
  const n = (await liveSearch())?.data ?? -1;
  writeFileSync("__result.json", JSON.stringify({ ok: n >= 1 }, null, 2));
}
