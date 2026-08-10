import { liveGdelt } from "./agent.js";
import { writeFileSync } from "node:fs";

// Opt-in: only hits the live GDELT API when AGENCY_LIVE_TESTS is set. The handler
// approves std::gdelt and std::http::fetchJSON and rejects anything else, so the call
// reaches the real API and an unexpected effect fails the test.
if (!process.env.AGENCY_LIVE_TESTS) {
  // Gated: vacuous pass, so the fixture matches both this branch and a live success.
  writeFileSync("__result.json", JSON.stringify({ ok: true }, null, 2));
} else {
  const n = (await liveGdelt())?.data ?? -1;
  writeFileSync("__result.json", JSON.stringify({ ok: n >= 1 }, null, 2));
}
