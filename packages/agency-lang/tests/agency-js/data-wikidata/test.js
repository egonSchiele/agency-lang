import { tSearchPath, tEntityPath, tQueryPath, tParseSearch, tParseSearchNull, tParseClaimValue, tParseEntity, tParseBindings, tEntityFinalizeUnknown, tSearchFinalizeErr, tQueryFinalizeErr, tError, hasInterrupts, approve, reject, respondToInterrupts, callSearch, callSearchGoverned, mockSearch, mockEntity, mockEntityUnknown, mockQuery } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const sampleSearch = load("./sample-search.json");
const sampleEntity = load("./sample-entity.json");
const sampleSparql = load("./sample-sparql.json");

// snaks exercising each parseClaimValue datatype branch
const snakEntity = { snaktype: "value", datavalue: { value: { id: "Q5" }, type: "wikibase-entityid" } };
const snakString = { snaktype: "value", datavalue: { value: "hello", type: "string" } };
const snakMono = { snaktype: "value", datavalue: { value: { text: "Bonjour", language: "fr" }, type: "monolingualtext" } };
const snakTime = { snaktype: "value", datavalue: { value: { time: "+1952-03-11T00:00:00Z" }, type: "time" } };
const snakQuantity = { snaktype: "value", datavalue: { value: { amount: "+1.96" }, type: "quantity" } };
const snakCoord = { snaktype: "value", datavalue: { value: { latitude: 51.5, longitude: -0.1 }, type: "globecoordinate" } };
const snakNovalue = { snaktype: "novalue", property: "P40" };

// --- interrupt / effect assertions (throw on mismatch) ---

// (A) The domain interrupt gates the call: rejecting std::wikidata short-circuits with NO fetch.
const i1 = await callSearch("Andreessen Horowitz");
if (!hasInterrupts(i1.data)) throw new Error("wikidataSearch did not raise an interrupt");
const iv = i1.data[0];
if (iv.effect !== "std::wikidata") throw new Error("wrong effect: " + iv.effect);
if (iv.data.op !== "search") throw new Error("wrong op discriminant: " + iv.data.op);
if (iv.data.query !== "Andreessen Horowitz") throw new Error("wrong payload: " + iv.data.query);
const rejected = await respondToInterrupts(i1.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("rejecting std::wikidata must short-circuit before any fetch");

// (B) Single-prompt ergonomics: a plain caller sees ONLY std::wikidata at the first hop.
if (i1.data.filter((x) => x.effect && x.effect !== "std::wikidata").length > 0) {
  throw new Error("plain caller must see only std::wikidata at the first hop");
}

// (C) Governance + offline URL wiring: propagate the fetch so std::http::fetchJSON surfaces with its
// { baseUrl, path }, asserted offline, then rejected (no network).
const g1 = await callSearchGoverned("Andreessen Horowitz");
if (!hasInterrupts(g1.data)) throw new Error("governed caller should surface std::http::fetchJSON via propagate()");
const gv = g1.data[0];
if (gv.effect !== "std::http::fetchJSON") throw new Error("expected std::http::fetchJSON, got: " + gv.effect);
if (gv.data.baseUrl !== "https://www.wikidata.org") throw new Error("wrong baseUrl: " + gv.data.baseUrl);
if (gv.data.path !== "/w/api.php?action=wbsearchentities&search=Andreessen%20Horowitz&language=en&format=json&limit=5") throw new Error("wrong path: " + gv.data.path);
await respondToInterrupts(g1.data, [reject()]);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      searchPath: unwrap(await tSearchPath("Andreessen Horowitz", 5)),
      entityPath: unwrap(await tEntityPath("Q42")),
      queryPath: unwrap(await tQueryPath("SELECT ?x WHERE { ?x wdt:P31 wd:Q5 } LIMIT 1")),
      search: unwrap(await tParseSearch(sampleSearch)),
      searchNull: unwrap(await tParseSearchNull()),
      cvEntity: unwrap(await tParseClaimValue(snakEntity)),
      cvString: unwrap(await tParseClaimValue(snakString)),
      cvMono: unwrap(await tParseClaimValue(snakMono)),
      cvTime: unwrap(await tParseClaimValue(snakTime)),
      cvQuantity: unwrap(await tParseClaimValue(snakQuantity)),
      cvCoord: unwrap(await tParseClaimValue(snakCoord)),
      cvNovalue: unwrap(await tParseClaimValue(snakNovalue)),
      entity: unwrap(await tParseEntity(sampleEntity)),
      bindings: unwrap(await tParseBindings(sampleSparql)),
      entityFinalizeUnknown: unwrap(await tEntityFinalizeUnknown()),
      searchFinalizeErr: unwrap(await tSearchFinalizeErr()),
      queryFinalizeErr: unwrap(await tQueryFinalizeErr()),
      errorMsg: unwrap(await tError()),
      mockSearch: unwrap(await mockSearch()),
      mockEntity: unwrap(await mockEntity()),
      mockEntityUnknown: unwrap(await mockEntityUnknown()),
      mockQuery: unwrap(await mockQuery()),
    },
    null,
    2,
  ),
);
