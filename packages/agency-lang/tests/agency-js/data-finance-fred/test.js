import { tBuildObs, tBuildSeries, tToFredMissing, tToFredNum, tParseObs, tParseObsSparse, tParseInfo, tParseObsNull, tParseInfoNull, tInfoEmpty, tObsMissing, tObsFetchError, tNoKey, callFred, hasInterrupts, reject, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => (r && typeof r === "object" && "data" in r ? r.data : r);
const obs = JSON.parse(readFileSync(new URL("./sample-observations.json", import.meta.url), "utf8"));
const series = JSON.parse(readFileSync(new URL("./sample-series.json", import.meta.url), "utf8"));

// --- no-key guard: must see FRED_API_KEY unset regardless of the dev's shell ---
delete process.env.FRED_API_KEY;
const noKey = unwrap(await tNoKey());

// --- interrupt/effect assertions: set a sentinel key so the interrupt is reached ---
const SENTINEL_KEY = "SENTINELKEY_leakguard_a1b2c3";
process.env.FRED_API_KEY = SENTINEL_KEY;
const fredInt = await callFred("UNRATE");
if (!hasInterrupts(fredInt.data)) throw new Error("fredSeries did not raise an interrupt");
const iv = fredInt.data[0];
if (iv.effect !== "std::fred") throw new Error("wrong FRED effect: " + iv.effect);
if (iv.data.seriesId !== "UNRATE") throw new Error("wrong FRED payload: " + JSON.stringify(iv.data));
// Leak regression guard: the std::fred interrupt payload must carry ONLY seriesId — never the key.
if (JSON.stringify(iv.data).includes(SENTINEL_KEY)) throw new Error("FRED api_key leaked into the std::fred interrupt payload");
if (JSON.stringify(Object.keys(iv.data)) !== JSON.stringify(["seriesId"])) throw new Error("unexpected FRED interrupt payload keys: " + JSON.stringify(Object.keys(iv.data)));
const rejected = await respondToInterrupts(fredInt.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("expected a final (rejected) result");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      obsPath: unwrap(await tBuildObs()),
      seriesPath: unwrap(await tBuildSeries()),
      toFredMissing: unwrap(await tToFredMissing()),
      toFredNum: unwrap(await tToFredNum()),
      parsedObs: unwrap(await tParseObs(obs)),
      parsedObsSparse: unwrap(await tParseObsSparse()),
      parsedInfo: unwrap(await tParseInfo(series)),
      parsedObsNull: unwrap(await tParseObsNull()),
      parsedInfoNull: unwrap(await tParseInfoNull()),
      infoEmpty: unwrap(await tInfoEmpty()),
      obsMissing: unwrap(await tObsMissing()),
      obsFetchError: unwrap(await tObsFetchError()),
      noKey,
    },
    null,
    2,
  ),
);
