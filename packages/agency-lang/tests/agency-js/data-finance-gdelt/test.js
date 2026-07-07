import { tBuild, tParse, tParseSparse, tParseNull, tFinalizeEmptyList, tFinalizeMissingArticles, tFinalizeFetchError, callGdelt, hasInterrupts, approve, reject, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const sample = JSON.parse(readFileSync(new URL("./sample-gdelt.json", import.meta.url), "utf8"));

// --- Offline interrupt / effect assertions (throw on mismatch) ---
// (A) The domain interrupt gates the call: rejecting std::gdelt short-circuits before any
// fetch happens (no network).
const i1 = await callGdelt("S&P 500 rate cut");
if (!hasInterrupts(i1.data)) throw new Error("gdeltNews did not raise an interrupt");
const iv = i1.data[0];
if (iv.effect !== "std::gdelt") throw new Error("wrong first effect: " + iv.effect);
if (iv.message !== "Search GDELT news for this query?") throw new Error("wrong message: " + iv.message);
if (iv.data.query !== "S&P 500 rate cut") throw new Error("wrong payload query: " + iv.data.query);
const rejected = await respondToInterrupts(i1.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("rejecting std::gdelt should short-circuit before any fetch");

// (B) Not preapproved: approving std::gdelt resumes into the fetch, which raises its own
// std::http::fetchJSON interrupt (proving both effects are raised and resumption works).
// We stop at this second interrupt — never approving it — so no network call is made.
const i2 = await respondToInterrupts((await callGdelt("q")).data, [approve()]);
if (!hasInterrupts(i2.data)) throw new Error("expected std::http::fetchJSON after approving std::gdelt");
if (i2.data[0].effect !== "std::http::fetchJSON") throw new Error("wrong second effect: " + i2.data[0].effect);

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
