import { tCatIdToName, tCatNameToId, tSearchPath, tEntityPath, tRelPath, tConnPath, tParseEntities, tParseEntity, tParseRelationships, tParseEmpty, tParseNull, tSearchFinalizeErr, tEntityFinalizeMissing, tRelFinalizeEmpty, tError, callRelBadCategory, hasInterrupts, approve, reject, respondToInterrupts, callSearch, callSearchGoverned } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const sampleSearch = load("./sample-search.json");
const sampleEntity = load("./sample-entity.json");
const sampleRels = load("./sample-relationships.json");
const sampleConns = load("./sample-connections.json");

// --- interrupt / effect assertions (throw on mismatch) ---

// (A) The domain interrupt gates the call: rejecting std::littlesis short-circuits with NO fetch.
const i1 = await callSearch("Andreessen Horowitz");
if (!hasInterrupts(i1.data)) throw new Error("littlesisSearch did not raise an interrupt");
const iv = i1.data[0];
if (iv.effect !== "std::littlesis") throw new Error("wrong effect: " + iv.effect);
if (iv.message !== "Search LittleSis for this name?") throw new Error("wrong message: " + iv.message);
if (iv.data.query !== "Andreessen Horowitz") throw new Error("wrong payload: " + iv.data.query);
if (iv.data.op !== "search") throw new Error("wrong op discriminant: " + iv.data.op); // tagged-union: per-op gating
const rejected = await respondToInterrupts(i1.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("rejecting std::littlesis must short-circuit before any fetch");

// (B) Single-prompt ergonomics: a plain caller (no fetch handler) sees ONLY std::littlesis. We do NOT
// approve here (approving would resume into the internally-approved fetch = a real network call).
if (i1.data.filter((x) => x.effect && x.effect !== "std::littlesis").length > 0) {
  throw new Error("plain caller must see only std::littlesis at the first hop");
}

// (C) Governance + offline URL wiring: the governed caller approves std::littlesis and PROPAGATES
// the fetch, so std::http::fetchJSON surfaces with its { baseUrl, path }. This proves (a) an outer
// handler still receives the fetch effect despite the connector's internal approve, and (b) the built
// URL is correct — asserted OFFLINE, then rejected so no network call happens.
const g1 = await callSearchGoverned("Andreessen Horowitz");
if (!hasInterrupts(g1.data)) throw new Error("governed caller should surface std::http::fetchJSON via propagate()");
const gv = g1.data[0];
if (gv.effect !== "std::http::fetchJSON") throw new Error("expected std::http::fetchJSON, got: " + gv.effect);
if (gv.data.baseUrl !== "https://littlesis.org/api") throw new Error("wrong baseUrl wired to fetch: " + gv.data.baseUrl);
if (gv.data.path !== "/entities/search?q=Andreessen%20Horowitz") throw new Error("wrong path wired to fetch: " + gv.data.path);
await respondToInterrupts(g1.data, [reject()]); // reject the fetch — no network

// (D) Unknown-category failure path, now OFFLINE-testable: because the connector validates the
// category BEFORE the interrupt, a bogus category returns a failure Result with NO interrupt and NO
// fetch. This also exercises the derived categoryNamesList() valid-list string (single source of truth).
const bad = await callRelBadCategory(41946);
if (hasInterrupts(bad.data)) throw new Error("bad category must fail before raising std::littlesis (no interrupt)");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      ownershipId: unwrap(await tCatNameToId("ownership")),
      donationName: unwrap(await tCatIdToName(5)),
      positionId: unwrap(await tCatNameToId("position")),
      unknownName: unwrap(await tCatNameToId("bogus")),
      unknownId: unwrap(await tCatIdToName(99)),
      zeroId: unwrap(await tCatIdToName(0)),
      searchPath: unwrap(await tSearchPath("Andreessen Horowitz", 1)),
      searchPathPaged: unwrap(await tSearchPath("a b", 3)),
      entityPath: unwrap(await tEntityPath(41946)),
      relPathPlain: unwrap(await tRelPath(41946, 0, "")),
      relPathCat: unwrap(await tRelPath(41946, 10, "")),
      relPathCatSort: unwrap(await tRelPath(41946, 10, "amount")),
      relPathSort: unwrap(await tRelPath(41946, 0, "recent")),
      connPathPlain: unwrap(await tConnPath(41946, 0)),
      connPathCat: unwrap(await tConnPath(41946, 10)),
      entities: unwrap(await tParseEntities(sampleSearch)),
      entity: unwrap(await tParseEntity(sampleEntity)),
      relationships: unwrap(await tParseRelationships(sampleRels)),
      connections: unwrap(await tParseEntities(sampleConns)),
      empty: unwrap(await tParseEmpty()),
      parseNull: unwrap(await tParseNull()),
      searchFinalizeErr: unwrap(await tSearchFinalizeErr()),
      entityFinalizeMissing: unwrap(await tEntityFinalizeMissing()),
      relFinalizeEmpty: unwrap(await tRelFinalizeEmpty()),
      errorMsg: unwrap(await tError()),
      badCategory: unwrap(await callRelBadCategory(41946)),
    },
    null,
    2,
  ),
);
