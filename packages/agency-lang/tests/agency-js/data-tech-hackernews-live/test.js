import { liveTop } from "./agent.js";
import { writeFileSync } from "node:fs";

// Opt-in: only hits the live HN API when AGENCY_LIVE_TESTS is set. Exercises the hydration loop
// (1 id-list fetch + up to 3 item fetches).
if (!process.env.AGENCY_LIVE_TESTS) {
  writeFileSync("__result.json", JSON.stringify({ skipped: true }, null, 2));
} else {
  const n = (await liveTop())?.data ?? -1;
  writeFileSync("__result.json", JSON.stringify({ ok: n >= 1 }, null, 2));
}
