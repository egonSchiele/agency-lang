import { liveSearch } from "./agent.js";
import { writeFileSync } from "node:fs";

// Opt-in: only hits the live LittleSis API when AGENCY_LIVE_TESTS is set. The handler approves both
// std::littlesis and std::http::fetchJSON, then resumes into the real fetch. If either approval is
// missing (or the internal approve regresses), the fetch is rejected and the count is 0.
if (!process.env.AGENCY_LIVE_TESTS) {
  // Gated: vacuous pass, so the fixture matches both this branch and a live success.
  writeFileSync("__result.json", JSON.stringify({ ok: true }, null, 2));
} else {
  const n = (await liveSearch())?.data ?? -1;
  writeFileSync("__result.json", JSON.stringify({ ok: n >= 1 }, null, 2));
}
