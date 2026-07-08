import { tSlugify, tParseListName, tBatchPath, tIndustryPath, tTagPath, tListPath, tMetaPath, tParseCompanies, tParseNull, tParseMeta, tMetaFinalize, tCompaniesFinalizeErr, tError, hasInterrupts, approve, reject, respondToInterrupts, callBatch, callBatchGoverned, callListBad, mockBatch, mockMeta, mockBatchBad } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const sampleBatch = load("./sample-batch.json");
const sampleMeta = load("./sample-meta.json");

// --- interrupt / effect assertions (throw on mismatch) ---

// (A) The domain interrupt gates the call: rejecting std::yc short-circuits with NO fetch.
const i1 = await callBatch("Winter 2009");
if (!hasInterrupts(i1.data)) throw new Error("ycBatch did not raise an interrupt");
const iv = i1.data[0];
if (iv.effect !== "std::yc") throw new Error("wrong effect: " + iv.effect);
if (iv.data.op !== "batch") throw new Error("wrong op discriminant: " + iv.data.op);
if (iv.data.query !== "Winter 2009") throw new Error("wrong payload: " + iv.data.query);
const rejected = await respondToInterrupts(i1.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("rejecting std::yc must short-circuit before any fetch");

// (B) Single-prompt ergonomics: a plain caller sees ONLY std::yc at the first hop.
if (i1.data.filter((x) => x.effect && x.effect !== "std::yc").length > 0) {
  throw new Error("plain caller must see only std::yc at the first hop");
}

// (C) Governance + offline URL wiring: propagate the fetch so std::http::fetchJSON surfaces with its
// { baseUrl, path }. Proves an outer handler still receives the fetch AND that the built URL (batch
// slugified to "winter-2009") is correct — asserted offline, then rejected so no network call happens.
const g1 = await callBatchGoverned("Winter 2009");
if (!hasInterrupts(g1.data)) throw new Error("governed caller should surface std::http::fetchJSON via propagate()");
const gv = g1.data[0];
if (gv.effect !== "std::http::fetchJSON") throw new Error("expected std::http::fetchJSON, got: " + gv.effect);
if (gv.data.baseUrl !== "https://yc-oss.github.io/api") throw new Error("wrong baseUrl: " + gv.data.baseUrl);
if (gv.data.path !== "/batches/winter-2009.json") throw new Error("wrong path: " + gv.data.path);
await respondToInterrupts(g1.data, [reject()]);

// (D) Unknown-list failure path, OFFLINE: bad list validates to a failure Result with NO interrupt.
const bad = await callListBad();
if (hasInterrupts(bad.data)) throw new Error("bad list must fail before raising std::yc (no interrupt)");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      slug1: unwrap(await tSlugify("Winter 2025")),
      slug2: unwrap(await tSlugify("  B2B SaaS ")),
      listOk: unwrap(await tParseListName("Top")),
      listBad: unwrap(await tParseListName("bogus")),
      batchPath: unwrap(await tBatchPath("winter-2025")),
      industryPath: unwrap(await tIndustryPath("fintech")),
      tagPath: unwrap(await tTagPath("ai")),
      listPath: unwrap(await tListPath("hiring")),
      metaPath: unwrap(await tMetaPath()),
      companies: unwrap(await tParseCompanies(sampleBatch)),
      parseNull: unwrap(await tParseNull()),
      meta: unwrap(await tParseMeta(sampleMeta)),
      metaFinalize: unwrap(await tMetaFinalize(sampleMeta)),
      companiesFinalizeErr: unwrap(await tCompaniesFinalizeErr()),
      errorMsg: unwrap(await tError()),
      mockBatch: unwrap(await mockBatch()),
      mockMeta: unwrap(await mockMeta()),
      mockBatchBad: unwrap(await mockBatchBad()),
    },
    null,
    2,
  ),
);
