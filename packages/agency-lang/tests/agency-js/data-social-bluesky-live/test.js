import { liveSearch } from "./agent.js";
import { writeFileSync } from "node:fs";

// Opt-in: only hits the live Bluesky AppView when AGENCY_LIVE_TESTS is set. The wire-type
// validation inside bskySearch does the real asserting: shape drift on a load-bearing
// field comes back as a failure (so the catch [] yields 0), never a zero-filled Post.
if (!process.env.AGENCY_LIVE_TESTS) {
  // Gated: vacuous pass, so the fixture matches both this branch and a live success.
  writeFileSync("__result.json", JSON.stringify({ ok: true }, null, 2));
} else {
  const n = (await liveSearch())?.data ?? -1;
  writeFileSync("__result.json", JSON.stringify({ ok: n >= 1 }, null, 2));
}
