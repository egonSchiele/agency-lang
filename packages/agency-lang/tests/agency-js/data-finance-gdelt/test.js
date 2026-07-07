import { tBuild, tParse, tParseSparse, tParseNull, tFinalizeEmptyList, tFinalizeMissingArticles, tFinalizeFetchError, callGdelt, hasInterrupts, reject, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const sample = JSON.parse(readFileSync(new URL("./sample-gdelt.json", import.meta.url), "utf8"));

// --- Offline interrupt / effect assertions (throw on mismatch) ---
const interrupted = await callGdelt("S&P 500 rate cut");
if (!hasInterrupts(interrupted.data)) throw new Error("gdeltNews did not raise an interrupt");
const iv = interrupted.data[0];
if (iv.effect !== "std::gdelt") throw new Error("wrong effect: " + iv.effect);
if (iv.message !== "Search GDELT news for this query?") throw new Error("wrong message: " + iv.message);
if (iv.data.query !== "S&P 500 rate cut") throw new Error("wrong payload query: " + iv.data.query);
const rejected = await respondToInterrupts(interrupted.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("expected a final (rejected) result");

// --- Pure-function results (compared against fixture.json) ---
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      path: unwrap(await tBuild("S&P 500 rate cut", 5, "3d")),
      articles: unwrap(await tParse(sample)),
      sparse: unwrap(await tParseSparse()),
      parseNull: unwrap(await tParseNull()),
      emptyList: unwrap(await tFinalizeEmptyList()),
      missingArticles: unwrap(await tFinalizeMissingArticles()),
      fetchError: unwrap(await tFinalizeFetchError()),
    },
    null,
    2,
  ),
);
