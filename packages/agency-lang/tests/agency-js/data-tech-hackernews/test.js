import { tParseStoryList, tParseSort, tCapLimit, tTakeFirst, tStoryListPath, tItemPath, tUserPath, tSearchPath, tParseStory, tParseItem, tParseUser, tParseHits, tParseHitsNull, tItemFinalizeNull, tSearchFinalizeErr, tError, hasInterrupts, approve, reject, respondToInterrupts, callItem, callItemGoverned, callSearchBad, mockStories, mockItem, mockItemNull, mockSearch } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const sampleItem = load("./sample-item.json");
const sampleUser = load("./sample-user.json");
const sampleSearch = load("./sample-search.json");

// --- interrupt / effect assertions (throw on mismatch) ---

// (A) The domain interrupt gates the call: rejecting std::hackernews short-circuits with NO fetch.
const i1 = await callItem(8863);
if (!hasInterrupts(i1.data)) throw new Error("hnItem did not raise an interrupt");
const iv = i1.data[0];
if (iv.effect !== "std::hackernews") throw new Error("wrong effect: " + iv.effect);
if (iv.data.op !== "item") throw new Error("wrong op discriminant: " + iv.data.op);
if (iv.data.query !== "8863") throw new Error("wrong payload: " + iv.data.query);
const rejected = await respondToInterrupts(i1.data, [reject()]);
if (hasInterrupts(rejected.data)) throw new Error("rejecting std::hackernews must short-circuit before any fetch");

// (B) Single-prompt ergonomics: a plain caller sees ONLY std::hackernews at the first hop.
if (i1.data.filter((x) => x.effect && x.effect !== "std::hackernews").length > 0) {
  throw new Error("plain caller must see only std::hackernews at the first hop");
}

// (C) Governance + offline URL wiring: propagate the fetch so std::http::fetchJSON surfaces with its
// { baseUrl, path } (Firebase host + item path), asserted offline, then rejected (no network).
const g1 = await callItemGoverned(8863);
if (!hasInterrupts(g1.data)) throw new Error("governed caller should surface std::http::fetchJSON via propagate()");
const gv = g1.data[0];
if (gv.effect !== "std::http::fetchJSON") throw new Error("expected std::http::fetchJSON, got: " + gv.effect);
if (gv.data.baseUrl !== "https://hacker-news.firebaseio.com/v0") throw new Error("wrong baseUrl: " + gv.data.baseUrl);
if (gv.data.path !== "/item/8863.json") throw new Error("wrong path: " + gv.data.path);
await respondToInterrupts(g1.data, [reject()]);

// (D) Unknown-sort failure path, OFFLINE: bad sort validates to a failure Result with NO interrupt.
const bad = await callSearchBad();
if (hasInterrupts(bad.data)) throw new Error("bad sort must fail before raising std::hackernews (no interrupt)");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      listTop: unwrap(await tParseStoryList("top")),
      listJob: unwrap(await tParseStoryList("job")),
      listBad: unwrap(await tParseStoryList("bogus")),
      sortRel: unwrap(await tParseSort("relevance")),
      sortRecent: unwrap(await tParseSort("recent")),
      sortBad: unwrap(await tParseSort("bogus")),
      capUnder: unwrap(await tCapLimit(30, 100)),
      capOver: unwrap(await tCapLimit(500, 100)),
      capNeg: unwrap(await tCapLimit(-5, 100)),
      takeSome: unwrap(await tTakeFirst([10, 20, 30, 40], 2)),
      takeOver: unwrap(await tTakeFirst([10], 5)),
      takeZero: unwrap(await tTakeFirst([10, 20], 0)),
      storyListPath: unwrap(await tStoryListPath("topstories")),
      itemPath: unwrap(await tItemPath(8863)),
      userPath: unwrap(await tUserPath("pg")),
      searchPath: unwrap(await tSearchPath("search", "rust async", "story", 20)),
      searchPathClamped: unwrap(await tSearchPath("search_by_date", "ai", "story", 500)),
      story: unwrap(await tParseStory(sampleItem)),
      item: unwrap(await tParseItem(sampleItem)),
      user: unwrap(await tParseUser(sampleUser)),
      hits: unwrap(await tParseHits(sampleSearch)),
      hitsNull: unwrap(await tParseHitsNull()),
      itemFinalizeNull: unwrap(await tItemFinalizeNull()),
      searchFinalizeErr: unwrap(await tSearchFinalizeErr()),
      errorMsg: unwrap(await tError()),
      mockStories: unwrap(await mockStories()),
      mockItem: unwrap(await mockItem()),
      mockItemNull: unwrap(await mockItemNull()),
      mockSearch: unwrap(await mockSearch()),
    },
    null,
    2,
  ),
);
