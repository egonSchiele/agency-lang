import { liveCheck } from "./agent.js";
import { writeFileSync } from "node:fs";

if (!process.env.AGENCY_LIVE_TESTS) {
  writeFileSync("__result.json", JSON.stringify({ skipped: true }, null, 2));
} else {
  const n = (await liveCheck())?.data ?? -1;
  writeFileSync("__result.json", JSON.stringify({ ok: n >= 1 }, null, 2));
}
