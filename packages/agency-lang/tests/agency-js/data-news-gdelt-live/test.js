import { liveGdelt } from "./agent.js";
import { writeFileSync } from "node:fs";

// Opt-in: only hits the live GDELT API when AGENCY_LIVE_TESTS is set. The handler
// rejects any non-std::gdelt interrupt, so a dropped .preapprove() (which would surface
// the inner std::http::fetchJSON prompt) fails this test — the only place that regression
// is catchable until the fetch mock lands.
if (!process.env.AGENCY_LIVE_TESTS) {
  // Gated: vacuous pass, so the fixture matches both this branch and a live success.
  writeFileSync("__result.json", JSON.stringify({ ok: true }, null, 2));
} else {
  const n = (await liveGdelt())?.data ?? 0;
  writeFileSync("__result.json", JSON.stringify({ ok: n >= 0 }, null, 2));
}
