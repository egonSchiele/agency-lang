import { tBuild, tParse, tParseRagged, tParseNull, tFinalizeEmptyDocs, tFinalizeNoSeries, tFinalizeFetchError, callDbnomics, hasInterrupts, reject, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const sample = JSON.parse(readFileSync(new URL("./sample-series.json", import.meta.url), "utf8"));

// --- interrupt / effect assertions ---
const interrupted = await callDbnomics();
if (!hasInterrupts(interrupted.data)) throw new Error("dbnomicsSeries did not raise an interrupt");
const iv = interrupted.data[0];
if (iv.effect !== "std::dbnomics") throw new Error("wrong effect: " + iv.effect);
if (iv.data.provider !== "BLS") throw new Error("wrong payload provider: " + JSON.stringify(iv.data));
const rejected = await respondToInterrupts(interrupted.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("expected a final (rejected) result");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      path: unwrap(await tBuild()),
      parsed: unwrap(await tParse(sample)),
      ragged: unwrap(await tParseRagged()),
      parseNull: unwrap(await tParseNull()),
      emptyDocs: unwrap(await tFinalizeEmptyDocs()),
      noSeries: unwrap(await tFinalizeNoSeries()),
      fetchError: unwrap(await tFinalizeFetchError()),
    },
    null,
    2,
  ),
);
