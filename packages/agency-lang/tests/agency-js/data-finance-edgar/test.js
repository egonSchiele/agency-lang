import { tSubPath, tArchive, tResolve, tResolveMissing, tResolveNull, tParseSubNull, tParseAll, tParse10K, tParseLimit1, tParseNoMatch, tFinalizeNoFilings, tFinalizeFetchError, callEdgar, hasInterrupts, approve, reject, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const tickers = JSON.parse(readFileSync(new URL("./sample-tickers.json", import.meta.url), "utf8"));
const submissions = JSON.parse(readFileSync(new URL("./sample-submissions.json", import.meta.url), "utf8"));

// --- interrupt / effect assertions ---
const interrupted = await callEdgar();
if (!hasInterrupts(interrupted.data)) throw new Error("edgarFilings did not raise an interrupt");
const iv = interrupted.data[0];
if (iv.effect !== "std::edgar") throw new Error("wrong effect: " + iv.effect);
if (iv.message !== "Fetch SEC filings for this company?") throw new Error("wrong message: " + iv.message);
if (iv.data.company !== "AAPL") throw new Error("wrong payload company: " + JSON.stringify(iv.data));
const rejected = await respondToInterrupts(interrupted.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("rejecting std::edgar should short-circuit before any fetch");
// Not preapproved: approving std::edgar resumes into the ticker fetch -> std::http::fetchJSON. Stop here (no network).
const edgarI2 = await respondToInterrupts((await callEdgar()).data, [approve()]);
if (!hasInterrupts(edgarI2.data)) throw new Error("expected std::http::fetchJSON after approving std::edgar");
if (edgarI2.data[0].effect !== "std::http::fetchJSON") throw new Error("wrong second EDGAR effect: " + edgarI2.data[0].effect);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      subPath: unwrap(await tSubPath()),
      archive: unwrap(await tArchive()),
      resolved: unwrap(await tResolve(tickers)),
      resolvedMissing: unwrap(await tResolveMissing(tickers)),
      resolvedNull: unwrap(await tResolveNull()),
      parseSubNull: unwrap(await tParseSubNull()),
      all: unwrap(await tParseAll(submissions)),
      tenK: unwrap(await tParse10K(submissions)),
      limit1: unwrap(await tParseLimit1(submissions)),
      noMatch: unwrap(await tParseNoMatch(submissions)),
      noFilings: unwrap(await tFinalizeNoFilings()),
      fetchError: unwrap(await tFinalizeFetchError()),
    },
    null,
    2,
  ),
);
