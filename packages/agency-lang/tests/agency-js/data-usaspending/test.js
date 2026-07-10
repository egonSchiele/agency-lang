import { tParseAwardType, tBuildAwardsBody, tAwardPath, tParseAwards, tParseAwardsNull, tParseAwardDetail, tAwardsFinalizeErr, tAwardDetailFinalizeNull, tError, hasInterrupts, approve, reject, respondToInterrupts, callAwards, callAward, callAwardsGoverned, callAwardGoverned, callAwardsBad, mockAwards, mockAward } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const sampleAwards = load("./sample-awards.json");
const sampleDetail = load("./sample-award-detail.json");

// --- interrupt / effect assertions (throw on mismatch) ---

// (A) Domain interrupt gates the call: it fires with the right payload, and rejecting it HALTS the
// call with a failure (callAwards is a reporting node → "REJECTED: …"), not just "no more interrupts".
const i1 = await callAwards();
if (!hasInterrupts(i1.data)) throw new Error("usaspendingAwards did not raise an interrupt");
const iv = i1.data[0];
if (iv.effect !== "std::usaspending") throw new Error("wrong effect: " + iv.effect);
if (iv.data.op !== "awards") throw new Error("wrong op: " + iv.data.op);
if (iv.data.query !== "Lockheed") throw new Error("wrong query: " + iv.data.query);
const rejected = await respondToInterrupts(i1.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("rejecting std::usaspending must short-circuit before any fetch");
if (!String(rejected.data).startsWith("REJECTED")) throw new Error("reject must halt the call with a failure, got: " + rejected.data);

// (B) Plain caller sees ONLY std::usaspending (no fetch prompt at the first hop).
if (i1.data.filter((x) => x.effect && x.effect !== "std::usaspending").length > 0) {
  throw new Error("plain caller must see only std::usaspending at the first hop");
}

// (E) Option-C single prompt: APPROVING std::usaspending resumes into the internally-approved fetch —
// no second (std::http::fetchJSON) prompt — and runs to success against the mock.
const e1 = await callAwards();
const resumed = await respondToInterrupts(e1.data, [approve()]);
if (hasInterrupts(resumed.data)) throw new Error("Option C: approving std::usaspending must NOT surface a second (fetch) prompt");
if (resumed.data !== "SUCCESS") throw new Error("approving std::usaspending should resume the internally-approved fetch to success, got: " + resumed.data);

// (C) Governance + POST wiring: the search's propagated fetch surfaces std::http::fetchJSON with
// method POST and the search path — asserted offline, then rejected (no network).
const g1 = await callAwardsGoverned();
if (!hasInterrupts(g1.data)) throw new Error("governed search should surface std::http::fetchJSON via propagate()");
const gv = g1.data[0];
if (gv.effect !== "std::http::fetchJSON") throw new Error("expected std::http::fetchJSON, got: " + gv.effect);
if (gv.data.baseUrl !== "https://api.usaspending.gov") throw new Error("wrong baseUrl: " + gv.data.baseUrl);
if (gv.data.path !== "/api/v2/search/spending_by_award/") throw new Error("wrong path: " + gv.data.path);
if (gv.data.method !== "POST") throw new Error("search must fetch with method POST, got: " + gv.data.method);
await respondToInterrupts(g1.data, [reject()]);

// (C2) The detail fetch surfaces with method GET AND the id-bearing path.
const g2 = await callAwardGoverned();
if (!hasInterrupts(g2.data)) throw new Error("governed detail should surface std::http::fetchJSON");
const g2v = g2.data[0];
if (g2v.data.method !== "GET") throw new Error("detail must fetch with method GET, got: " + g2v.data.method);
if (g2v.data.path !== "/api/v2/awards/22834500/") throw new Error("wrong detail path: " + g2v.data.path);
await respondToInterrupts(g2.data, [reject()]);

// (F) The detail interrupt payload carries op "award" and the award id.
const d1 = await callAward();
if (!hasInterrupts(d1.data)) throw new Error("usaspendingAward did not raise an interrupt");
const dv = d1.data[0];
if (dv.effect !== "std::usaspending") throw new Error("wrong detail effect: " + dv.effect);
if (dv.data.op !== "award") throw new Error("wrong detail op: " + dv.data.op);
if (dv.data.query !== "22834500") throw new Error("wrong detail query: " + dv.data.query);
await respondToInterrupts(d1.data, [reject()]);

// (D) Bad awardType fails BEFORE the interrupt (no fetch, no interrupt) and for the right reason.
const bad = await callAwardsBad();
if (hasInterrupts(bad.data)) throw new Error("bad awardType must fail before raising std::usaspending");
if (!String(bad.data).includes("unknown awardType")) throw new Error("bad awardType must fail with the validation message, got: " + bad.data);

// (G) parseAwardType validates via own-key membership, so prototype-chain keys (__proto__, constructor)
// are rejected, not accidentally accepted by bracket indexing.
const proto = String(unwrap(await tParseAwardType("__proto__")));
if (!proto.startsWith("FAIL")) throw new Error("parseAwardType must reject prototype keys like __proto__, got: " + proto);

// (H) placeString single-component cases: city-only or state-only returns the lone component, never
// a dangling ", ST" or "City, ".
const cityOnly = unwrap(await tParseAwardDetail({ place_of_performance: { city_name: "FORT WORTH" } }));
if (cityOnly.placeOfPerformance !== "FORT WORTH") throw new Error("city-only place must be 'FORT WORTH', got: " + cityOnly.placeOfPerformance);
const stateOnly = unwrap(await tParseAwardDetail({ place_of_performance: { state_code: "TX" } }));
if (stateOnly.placeOfPerformance !== "TX") throw new Error("state-only place must be 'TX', got: " + stateOnly.placeOfPerformance);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      typeContracts: unwrap(await tParseAwardType("contracts")),
      typeGrants: unwrap(await tParseAwardType("grants")),
      typeBad: unwrap(await tParseAwardType("bogus")),
      bodyMinimal: unwrap(await tBuildAwardsBody(["02", "03", "04", "05"], "", "", "", "", 10)),
      bodyFull: unwrap(await tBuildAwardsBody(["A", "B", "C", "D"], "Lockheed", "Department of Defense", "2023-01-01", "2023-12-31", 5)),
      bodyStartOnly: unwrap(await tBuildAwardsBody(["A", "B", "C", "D"], "", "", "2023-01-01", "", 10)),
      awardPath: unwrap(await tAwardPath("22834500")),
      awardPathEnc: unwrap(await tAwardPath("a b/c")),
      awards: unwrap(await tParseAwards(sampleAwards)),
      awardsNull: unwrap(await tParseAwardsNull()),
      awardsSparse: unwrap(await tParseAwards({ results: [{}] })),
      detail: unwrap(await tParseAwardDetail(sampleDetail)),
      detailEmpty: unwrap(await tParseAwardDetail({})),
      awardsFinalizeErr: unwrap(await tAwardsFinalizeErr()),
      awardDetailFinalizeNull: unwrap(await tAwardDetailFinalizeNull()),
      errorMsg: unwrap(await tError("boom")),
      errorMsgObj: unwrap(await tError({ message: "boom-msg" })),
      mockAwards: unwrap(await mockAwards()),
      mockAward: unwrap(await mockAward()),
    },
    null,
    2,
  ),
);
