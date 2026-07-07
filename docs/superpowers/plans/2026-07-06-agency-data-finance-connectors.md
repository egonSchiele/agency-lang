# `std::data/finance/*` Evidence Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Per the owner's standing preference, do NOT use subagent-driven development — implement inline in the main session.)

**Goal:** Add four pure-Agency standard-library connectors — GDELT (news), FRED (US macro), DBnomics (world macro), and SEC EDGAR (company filings) — that turn real HTTP+JSON APIs into typed Agency values, as the evidence layer for a future forecasting agent.

**Architecture:** Each connector is a single `.agency` file under `stdlib/data/finance/`, built on `std::http`'s `fetchJSON`. It exposes one (or two, for EDGAR) module-level constrained client (`fetchJSON.partial(baseUrl, allowedDomains).preapprove()`), a source-specific approval `effect`, and splits its logic into **pure, independently testable functions**: `buildXPath(...)` (URL/query construction, always `encodeURIComponent`-escaping user input), `parseX(raw)` (JSON→typed reshaping, total on malformed input), and `xFinalize(fetchResult)` (turns the fetch `Result` into the final `Result`, incl. error/edge handling). **Every connector, including EDGAR, uses a finalize function** — no orchestrator inlines finalize logic. The public function is a thin orchestrator: raise interrupt → `xFinalize(client(buildXPath(...)))`.

**Tech Stack:** Agency (pure `.agency`, no TypeScript backing), `std::http`, the auto-imported `std::index` array helpers (`map`, `filter`, `find`, `range`), typed JS string/global members (`padStart`, `replaceAll`, `slice`, `toUpperCase`, `charAt`, `encodeURIComponent`, `Number`, `Object.values`), agency-js tests (`tests/agency-js/`) for pure-function + offline interrupt/effect coverage.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-06-agency-data-connectors-design.md` — this plan implements it. Read §5 (recipe), §6 (per-connector detail), §8 (shared concerns) before starting.
- **Pure Agency only.** No `lib/stdlib/*.ts` backing files for these connectors.
- **Module paths:** `std::data/finance/gdelt`, `.../fred`, `.../edgar`, `.../dbnomics`. Files: `stdlib/data/finance/<name>.agency`.
- **Effect labels are flat:** `std::gdelt`, `std::fred`, `std::edgar`, `std::dbnomics`. Register each in the `Network` effect set in `stdlib/capabilities.agency` (the line at `stdlib/capabilities.agency:45`).
- **Build after every stdlib change:** run `make` (per CLAUDE.md — `pnpm run build` does NOT copy stdlib for the CLI).
- **Lint & format new files:** `pnpm run lint:structure` and `pnpm run fmt <file>`.
- **Run agency-js tests with the correct command:** `pnpm run test:agency-js` hardcodes the whole `tests/agency-js` dir, so `-- <dir>` runs the entire suite (slow; forbidden by CLAUDE.md). Use the `a` alias to target one dir: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/<dir> 2>&1 | tee /tmp/<dir>.log`.
- **Use typed JS members, not hand-rolled loops.** `lib/typeChecker/primitiveMembers.ts` types `padStart`, `replaceAll`, `slice`, `substring`, `charAt`, `split`, `toUpperCase`, `startsWith`, `includes`, `trim` on strings and `slice` on arrays; `encodeURIComponent`, `Number`, `Object.values` are typed globals (`resolveCall.ts`). Do NOT hand-roll character loops or `s[i]` / `for (c in s)` (no precedent, behavior unknown).
- **Three doc mechanisms, all required per connector:**
  - `"""docstring"""` (first statement in a function body) → the **LLM tool description** + the function's description in generated docs; use `@param name - description`. Concise — the model sees it every call.
  - `/** ... */` doc comment (own line above a `type`/`def`) → extra reference docs (Markdown). Put one on every exported `type`.
  - `/** @module ... */` → module overview. **Placed AFTER the imports, before any other code** (matches `stdlib/date.agency`, `stdlib/git.agency:13`). Must contain a runnable usage example and a paragraph on what the source returns and when to pick this connector vs. the others (spec §1/§10).
- **Export the public types:** write `export type X = {...}` (precedent `stdlib/markdown.agency:39`), so callers can annotate over connector data.
- **Mark functions `safe`:** every function here is side-effect-free or an idempotent GET — use `export safe def` throughout (matches `weather`, `wikipedia`, the `std::http` fetchers).
- **Agency syntax reminders:** `if`/`while`/`for` need `(...)` + `{...}`; declare with `let`/`const`; reshape with `map(arr) as x { return ... }` / `filter(arr) as x { return ... }` blocks; field-absence default via `?? default` (guard EVERY parent in a chain: `(a ?? {}).b ?? c`, not `a.b ?? c`); unwrap Results via `match (r) { success(v) => ...  failure(e) => ... }` or `if (r is failure(e))`. No ternaries. **Comments must be on their own line.** No trailing commas inside named-arg *calls* (no precedent; keep them only in param declarations / object literals).
- **No LLM calls in tests.** Pure functions + interrupts are exercised with fixed inputs; run agency-js with `AGENCY_USE_TEST_LLM_PROVIDER=1`, no `llmMocks` needed.
- **Sample fixtures must be trimmed *real captures*, not hand-written compositions** (spec §9). The EDGAR (Apple `CIK0000320193`) and DBnomics (`BLS/cu/CUUR0000SA0`) responses were captured live during design — use them. For GDELT and FRED, capture a real response during execution (`curl` GDELT once respecting its 1-req/5s limit; a real FRED response with your key) and trim it; the samples below are close but must be replaced with captures, then fixtures re-derived from the parser output.
- **Coverage note (state in code review):** the pure trio + offline interrupt tests cover all logic and the effect/approval surface without network. The one thing NOT covered in CI is "exactly one approval prompt per call" (that the `.preapprove()` suppresses the inner `std::http::fetchJSON` prompt) — that needs the in-progress fetch mock or the opt-in live smoke (whose handler asserts the effect is the connector's own and rejects anything else).

---

### Task 1: GDELT connector (`std::data/finance/gdelt`) — reference implementation

Establishes the pattern: `encodeURIComponent`, the pure trio, the constrained client, the effect, all three doc mechanisms, and both test kinds (pure-function fixtures + offline interrupt/effect).

**Files:**
- Create: `stdlib/data/finance/gdelt.agency`
- Modify: `stdlib/capabilities.agency` (add `std::gdelt` to `Network`)
- Test: `tests/agency-js/data-finance-gdelt/{agent.agency,test.js,fixture.json,sample-gdelt.json}`

**Interfaces (exported from `std::data/finance/gdelt`):**
- `type NewsArticle = { title: string; url: string; domain: string; language: string; sourceCountry: string; seenDate: string }`
- `safe def buildGdeltPath(query: string, maxRecords: number, timespan: string): string`
- `safe def parseGdelt(raw: any): NewsArticle[]`
- `safe def gdeltFinalize(fetchResult: any): Result`
- `safe def gdeltNews(query: string, maxRecords: number = 25, timespan: string = "3d"): Result`

- [ ] **Step 1: Write the failing test first**

Create `tests/agency-js/data-finance-gdelt/sample-gdelt.json` (replace with a real trimmed capture during execution):

```json
{
  "articles": [
    { "url": "https://example.com/a", "title": "Fed holds rates steady", "domain": "example.com", "language": "English", "sourcecountry": "United States", "seendate": "20260701T120000Z" },
    { "url": "https://news.test/b", "title": "Markets react", "domain": "news.test", "language": "English", "sourcecountry": "United States", "seendate": "20260701T130000Z" }
  ]
}
```

Create `tests/agency-js/data-finance-gdelt/agent.agency`:

```
import { buildGdeltPath, parseGdelt, gdeltFinalize, gdeltNews } from "std::data/finance/gdelt"

node tBuild(query: string, maxRecords: number, timespan: string): string {
  return buildGdeltPath(query, maxRecords, timespan)
}

node tParse(raw: any): any {
  return parseGdelt(raw)
}

node tParseSparse(): any {
  return parseGdelt({ articles: [{}] })
}

node tFinalizeEmptyList(): any {
  return gdeltFinalize(success({ articles: [] })) catch "FAIL"
}

node tFinalizeMissingArticles(): any {
  return gdeltFinalize(success({})) catch "FAIL"
}

node tFinalizeFetchError(): string {
  const r = gdeltFinalize(failure("boom"))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED_SUCCESS"
}

node callGdelt(query: string): any {
  return gdeltNews(query)
}
```

Create `tests/agency-js/data-finance-gdelt/test.js`:

```javascript
import { tBuild, tParse, tParseSparse, tFinalizeEmptyList, tFinalizeMissingArticles, tFinalizeFetchError, callGdelt, hasInterrupts, reject, respondToInterrupts } from "./agent.js";
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
      emptyList: unwrap(await tFinalizeEmptyList()),
      missingArticles: unwrap(await tFinalizeMissingArticles()),
      fetchError: unwrap(await tFinalizeFetchError()),
    },
    null,
    2,
  ),
);
```

Create `tests/agency-js/data-finance-gdelt/fixture.json`:

```json
{
  "path": "?query=S%26P%20500%20rate%20cut&mode=artlist&format=json&maxrecords=5&timespan=3d",
  "articles": [
    { "title": "Fed holds rates steady", "url": "https://example.com/a", "domain": "example.com", "language": "English", "sourceCountry": "United States", "seenDate": "20260701T120000Z" },
    { "title": "Markets react", "url": "https://news.test/b", "domain": "news.test", "language": "English", "sourceCountry": "United States", "seenDate": "20260701T130000Z" }
  ],
  "sparse": [ { "title": "", "url": "", "domain": "", "language": "", "sourceCountry": "", "seenDate": "" } ],
  "emptyList": [],
  "missingArticles": [],
  "fetchError": "GDELT request failed: boom"
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-gdelt 2>&1 | tee /tmp/gdelt-test.log`
Expected: FAIL — the module `std::data/finance/gdelt` does not exist yet (import/compile error).

- [ ] **Step 3: Create the connector file**

Create `stdlib/data/finance/gdelt.agency`:

```
import { fetchJSON } from "std::http"

/** @module
  ## GDELT — worldwide news coverage

  Search global online news via the [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/).
  Use this connector for the *qualitative, fast-moving* signal — what the world is reporting
  right now about an event, company, or topic. It returns recent matching articles (title,
  URL, source domain, language, source country, and GDELT's seen-date). It tells you what is
  being *said*, not what is *true* — for authoritative company facts use
  `std::data/finance/edgar`; for economic numbers use `std::data/finance/fred` or
  `std::data/finance/dbnomics`.

  No API key required. GDELT asks callers to make at most one request every 5 seconds; on a
  zero-match query it returns no `articles` (this connector returns an empty list).

  ### Usage

  ```ts
  import { gdeltNews } from "std::data/finance/gdelt"

  node main() {
    const articles = gdeltNews("Federal Reserve interest rate decision", 10, "1w") catch []
    for (article in articles) {
      print("${article.seenDate}  ${article.domain}  ${article.title}")
    }
  }
  ```
*/

effect std::gdelt { query: string }

/** One news article returned by GDELT. `seenDate` is GDELT's `YYYYMMDDTHHMMSSZ` string. */
export type NewsArticle = {
  title: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  seenDate: string
}

// One module-level constrained client. `.preapprove()` silences the generic
// std::http::fetchJSON prompt so callers see only the std::gdelt prompt. The baseUrl
// ends at ".../doc" (not ".../doc/doc") because resolveUrl inserts a "/" before the
// path, and buildGdeltPath returns a path beginning "doc?..." (see resolveUrl in
// lib/stdlib/http.ts).
const gdeltClient = fetchJSON.partial(
  baseUrl: "https://api.gdeltproject.org/api/v2/doc",
  allowedDomains: ["api.gdeltproject.org"]
).preapprove()

/** Build the GDELT DOC query path (query is URL-encoded). Pure — no network. */
export safe def buildGdeltPath(query: string, maxRecords: number, timespan: string): string {
  const q = encodeURIComponent(query)
  return "doc?query=${q}&mode=artlist&format=json&maxrecords=${maxRecords}&timespan=${timespan}"
}

/** Reshape a raw GDELT DOC response body into NewsArticle[]. Pure — total on missing fields. */
export safe def parseGdelt(raw: any): NewsArticle[] {
  const articles = raw.articles ?? []
  return map(articles) as article {
    return {
      title: article.title ?? "",
      url: article.url ?? "",
      domain: article.domain ?? "",
      language: article.language ?? "",
      sourceCountry: article.sourcecountry ?? "",
      seenDate: article.seendate ?? ""
    }
  }
}

/** Turn a fetchJSON Result into the final Result. Pure — testable with mock Results. */
export safe def gdeltFinalize(fetchResult: any): Result {
  return match (fetchResult) {
    success(body) => success(parseGdelt(body))
    failure(err) => failure("GDELT request failed (the API may be rate-limited to 1 request / 5s): ${err}")
  }
}

export safe def gdeltNews(query: string, maxRecords: number = 25, timespan: string = "3d"): Result {
  """
  Search worldwide online news coverage for a query via GDELT DOC 2.0. Returns recent
  matching articles (title, URL, source domain, language, source country, and the GDELT
  seen-date); a zero-match query returns an empty list. Use for current events, public
  attention, and sentiment. Note: GDELT is rate-limited to about one request every 5 seconds.

  @param query - Search terms in GDELT DOC query syntax, e.g. "Federal Reserve rate cut"
  @param maxRecords - Maximum number of articles to return, 1-250 (default 25)
  @param timespan - How far back to search, e.g. "24h", "3d", "1w" (default "3d")
  """
  return interrupt std::gdelt("Search GDELT news for this query?", { query: query })
  return gdeltFinalize(gdeltClient(path: buildGdeltPath(query, maxRecords, timespan)))
}
```

Note: `parseGdelt` is already total, so `gdeltFinalize`'s success arm is a plain `success(parseGdelt(body))` — an absent or empty `articles` both yield `success([])` (spec §6.1). The rate-limit hint lives in the `failure` arm, because GDELT's rate-limit body is non-JSON and fails parsing inside `fetchJSON`, arriving as a `failure`. (The spec's "failure carrying the server text" is not achievable through `fetchJSON`'s parse error — accepted deviation.)

- [ ] **Step 4: Build and run the test to verify it passes**

Run: `make && AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-gdelt 2>&1 | tee /tmp/gdelt-test.log`
Expected: PASS — `__result.json` matches `fixture.json`, and the interrupt/effect assertions in `test.js` do not throw. Note the fixture's `path` asserts the encoded form (`S%26P%20500...`).

- [ ] **Step 5: Register the effect**

In `stdlib/capabilities.agency`, add `std::gdelt` to the `Network` effect set (the `export effectSet Network = <...>` line):

```
export effectSet Network = <std::http::fetch, std::http::fetchJSON, std::http::fetchMarkdown, std::search, std::tavilySearch, std::weather, std::browserUse, std::wikipedia::article, std::wikipedia::search, std::wikipedia::summary, std::gdelt>
```

- [ ] **Step 6: Build, lint, format**

Run: `make && pnpm run lint:structure && pnpm run fmt stdlib/data/finance/gdelt.agency`
Expected: pass; run `fmt` twice to confirm idempotence.

- [ ] **Step 7: Add the opt-in live smoke test (env-gated, not CI)**

Create `tests/agency-js/data-finance-gdelt-live/agent.agency`:

```
import { gdeltNews } from "std::data/finance/gdelt"

node liveGdelt(): number {
  handle {
    const articles = gdeltNews("technology", 3, "1w") catch []
    return articles.length
  } with (data) {
    if (data.effect == "std::gdelt") {
      return approve()
    }
    return reject()
  }
}
```

Create `tests/agency-js/data-finance-gdelt-live/test.js`:

```javascript
import { liveGdelt } from "./agent.js";
import { writeFileSync } from "node:fs";

if (!process.env.AGENCY_LIVE_TESTS) {
  writeFileSync("__result.json", JSON.stringify({ skipped: true }, null, 2));
} else {
  const n = (await liveGdelt())?.data ?? 0;
  writeFileSync("__result.json", JSON.stringify({ ok: n >= 0 }, null, 2));
}
```

Create `tests/agency-js/data-finance-gdelt-live/fixture.json`:

```json
{ "skipped": true }
```

Note: the handler rejects any non-`std::gdelt` interrupt, so if `.preapprove()` is ever dropped the inner `std::http::fetchJSON` prompt would be rejected and the live test would fail — the only place that regression is catchable until the fetch mock lands. Run locally with `AGENCY_LIVE_TESTS=1 pnpm run a test js tests/agency-js/data-finance-gdelt-live` (delete the generated fixture line or expect `{ok:true}` when live).

- [ ] **Step 8: Commit**

```bash
git add stdlib/data/finance/gdelt.agency stdlib/capabilities.agency tests/agency-js/data-finance-gdelt tests/agency-js/data-finance-gdelt-live
git commit -F - <<'MSG'
feat(stdlib): add std::data/finance/gdelt news connector

Pure-Agency GDELT DOC 2.0 connector: buildGdeltPath (encodeURIComponent) /
parseGdelt / gdeltFinalize trio + gdeltNews orchestrator, std::gdelt effect.
Offline interrupt/effect test + opt-in live smoke.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 2: FRED connector (`std::data/finance/fred`)

Adds env-based API key (`FRED_API_KEY`), optional query params (all via one `appendParam` fold), the `"."`→null value edge, and a real secret-leak verification.

**Files:**
- Create: `stdlib/data/finance/fred.agency`
- Modify: `stdlib/capabilities.agency` (add `std::fred`)
- Test: `tests/agency-js/data-finance-fred/{agent.agency,test.js,fixture.json,sample-observations.json,sample-series.json}`

**Interfaces (exported from `std::data/finance/fred`):**
- `type FredObservation = { date: string; value: number | null }`
- `type FredSeries = { seriesId: string; units: string; observations: FredObservation[] }` (`units` is the units *transform code*, e.g. `"lin"`)
- `type FredSeriesInfo = { id: string; title: string; units: string; frequency: string; observationStart: string; observationEnd: string; notes: string }`
- `safe def buildFredObservationsPath(seriesId: string, apiKey: string, observationStart: string, observationEnd: string, frequency: string, units: string, limit: number): string`
- `safe def buildFredSeriesPath(seriesId: string, apiKey: string): string`
- `safe def toFredValue(raw: string): number | null`
- `safe def parseFredObservations(seriesId: string, raw: any): FredSeries`
- `safe def parseFredInfo(raw: any): FredSeriesInfo`
- `safe def fredObservationsFinalize(seriesId: string, fetchResult: any): Result`
- `safe def fredInfoFinalize(fetchResult: any): Result`
- `safe def fredSeries(seriesId, observationStart = "", observationEnd = "", frequency = "", units = "", limit = 0): Result`
- `safe def fredSeriesInfo(seriesId: string): Result`

- [ ] **Step 1: Write the failing test first**

Create `tests/agency-js/data-finance-fred/sample-observations.json` (replace with a real capture):

```json
{ "units": "lin", "observations": [ { "date": "2024-01-01", "value": "3.7" }, { "date": "2024-02-01", "value": "." }, { "date": "2024-03-01", "value": "3.9" } ] }
```

Create `tests/agency-js/data-finance-fred/sample-series.json` (replace with a real capture):

```json
{ "seriess": [ { "id": "UNRATE", "title": "Unemployment Rate", "units": "Percent", "frequency": "Monthly", "observation_start": "1948-01-01", "observation_end": "2026-06-01", "notes": "Seasonally adjusted." } ] }
```

Create `tests/agency-js/data-finance-fred/agent.agency`:

```
import {
  buildFredObservationsPath,
  buildFredSeriesPath,
  parseFredObservations,
  parseFredInfo,
  fredObservationsFinalize,
  fredInfoFinalize,
  fredSeries
} from "std::data/finance/fred"

node tBuildObs(): string {
  return buildFredObservationsPath("UNRATE", "KEY", "2024-01-01", "", "m", "", 100)
}

node tBuildSeries(): string {
  return buildFredSeriesPath("UNRATE", "KEY")
}

node tParseObs(raw: any): any {
  return parseFredObservations("UNRATE", raw)
}

node tParseObsSparse(): any {
  return parseFredObservations("X", { observations: [{ date: "2024-01-01" }] })
}

node tParseInfo(raw: any): any {
  return parseFredInfo(raw)
}

node tInfoEmpty(): string {
  const r = fredInfoFinalize(success({ seriess: [] }))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}

node tObsMissing(): string {
  const r = fredObservationsFinalize("BADID", success({}))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}

node tObsFetchError(): string {
  const r = fredObservationsFinalize("X", failure("boom"))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}

node tNoKey(): string {
  const r = fredSeries("UNRATE")
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}
```

Create `tests/agency-js/data-finance-fred/test.js`:

```javascript
import { tBuildObs, tBuildSeries, tParseObs, tParseObsSparse, tParseInfo, tInfoEmpty, tObsMissing, tObsFetchError, tNoKey } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

delete process.env.FRED_API_KEY; // tNoKey must see it unset regardless of the dev's shell
const unwrap = (r) => r?.data ?? r;
const obs = JSON.parse(readFileSync(new URL("./sample-observations.json", import.meta.url), "utf8"));
const series = JSON.parse(readFileSync(new URL("./sample-series.json", import.meta.url), "utf8"));

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      obsPath: unwrap(await tBuildObs()),
      seriesPath: unwrap(await tBuildSeries()),
      parsedObs: unwrap(await tParseObs(obs)),
      parsedObsSparse: unwrap(await tParseObsSparse()),
      parsedInfo: unwrap(await tParseInfo(series)),
      infoEmpty: unwrap(await tInfoEmpty()),
      obsMissing: unwrap(await tObsMissing()),
      obsFetchError: unwrap(await tObsFetchError()),
      noKey: unwrap(await tNoKey()),
    },
    null,
    2,
  ),
);
```

Create `tests/agency-js/data-finance-fred/fixture.json`:

```json
{
  "obsPath": "series/observations?series_id=UNRATE&api_key=KEY&file_type=json&observation_start=2024-01-01&frequency=m&limit=100",
  "seriesPath": "series?series_id=UNRATE&api_key=KEY&file_type=json",
  "parsedObs": { "seriesId": "UNRATE", "units": "lin", "observations": [ { "date": "2024-01-01", "value": 3.7 }, { "date": "2024-02-01", "value": null }, { "date": "2024-03-01", "value": 3.9 } ] },
  "parsedObsSparse": { "seriesId": "X", "units": "", "observations": [ { "date": "2024-01-01", "value": null } ] },
  "parsedInfo": { "id": "UNRATE", "title": "Unemployment Rate", "units": "Percent", "frequency": "Monthly", "observationStart": "1948-01-01", "observationEnd": "2026-06-01", "notes": "Seasonally adjusted." },
  "infoEmpty": "FRED returned no series metadata (check the series id)",
  "obsMissing": "FRED returned no observations for 'BADID' (check the series id)",
  "obsFetchError": "FRED request failed: boom",
  "noKey": "FRED_API_KEY is not set. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html"
}
```

Note on `parseFredObservations` sparse case: an observation missing `value` → `toFredValue(o.value ?? ".")` → `null`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-fred 2>&1 | tee /tmp/fred-test.log`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Create the connector file**

Create `stdlib/data/finance/fred.agency`:

```
import { fetchJSON } from "std::http"
import { env } from "std::system"

/** @module
  ## FRED — U.S. macroeconomic time-series

  Fetch U.S. economic data from the Federal Reserve Bank of St. Louis
  [FRED API](https://fred.stlouisfed.org/docs/api/fred/): interest rates, CPI (inflation),
  unemployment, GDP, and ~800k other series, each addressed by its `series_id`
  (e.g. `UNRATE`, `CPIAUCSL`, `FEDFUNDS`). This is the curated gold standard for *U.S.*
  macro; for non-U.S. or cross-country data use `std::data/finance/dbnomics`; for news use
  `std::data/finance/gdelt`.

  Returns a series as a list of `{ date, value }` observations (a missing value is `null`),
  oldest-first, plus a `fredSeriesInfo` call for a series' title/display-units/frequency/coverage.

  ### Setup

  Requires a free API key. Get one at https://fred.stlouisfed.org/docs/api/api_key.html and
  set it as the `FRED_API_KEY` environment variable.

  ### Usage

  ```ts
  import { fredSeries } from "std::data/finance/fred"

  node main() {
    const series = fredSeries("UNRATE", "2024-01-01") catch { seriesId: "", units: "", observations: [] }
    for (obs in series.observations) {
      print("${obs.date}: ${obs.value}")
    }
  }
  ```
*/

effect std::fred { seriesId: string }

/** A single FRED observation. `value` is null when FRED reports the value as missing ("."). */
export type FredObservation = {
  date: string;
  value: number | null
}

/** A FRED data series. `units` is the requested units *transform code* (e.g. "lin", "pch"),
    not the display label — use fredSeriesInfo for the display units. */
export type FredSeries = {
  seriesId: string;
  units: string;
  observations: FredObservation[]
}

/** Metadata about a FRED series. `units` here IS the human display label (e.g. "Percent"). */
export type FredSeriesInfo = {
  id: string;
  title: string;
  units: string;
  frequency: string;
  observationStart: string;
  observationEnd: string;
  notes: string
}

const fredClient = fetchJSON.partial(
  baseUrl: "https://api.stlouisfed.org/fred/",
  allowedDomains: ["api.stlouisfed.org"]
).preapprove()

/** Append "&key=value" only when value is non-empty (value is URL-encoded). Pure. */
def appendParam(path: string, key: string, value: string): string {
  if (value == "") {
    return path
  }
  return "${path}&${key}=${encodeURIComponent(value)}"
}

/** Build the series/observations query path. Pure — no network. */
export safe def buildFredObservationsPath(seriesId: string, apiKey: string, observationStart: string, observationEnd: string, frequency: string, units: string, limit: number): string {
  let path = "series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json"
  path = appendParam(path, "observation_start", observationStart)
  path = appendParam(path, "observation_end", observationEnd)
  path = appendParam(path, "frequency", frequency)
  path = appendParam(path, "units", units)
  let limitStr = ""
  if (limit > 0) {
    limitStr = "${limit}"
  }
  return appendParam(path, "limit", limitStr)
}

/** Build the series (metadata) query path. Pure — no network. */
export safe def buildFredSeriesPath(seriesId: string, apiKey: string): string {
  return "series?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json"
}

/** Convert a FRED value string to a number, or null for the missing marker ".". Pure. */
export safe def toFredValue(raw: string): number | null {
  if (raw == ".") {
    return null
  }
  return Number(raw)
}

/** Reshape a series/observations response. Pure — total on missing fields. */
export safe def parseFredObservations(seriesId: string, raw: any): FredSeries {
  const rawObs = raw.observations ?? []
  const observations = map(rawObs) as obs {
    return { date: obs.date ?? "", value: toFredValue(obs.value ?? ".") }
  }
  return { seriesId: seriesId, units: raw.units ?? "", observations: observations }
}

/** Reshape a series (metadata) response, taking the first series. Pure. */
export safe def parseFredInfo(raw: any): FredSeriesInfo {
  const list = raw.seriess ?? []
  const info = list[0] ?? {}
  return {
    id: info.id ?? "",
    title: info.title ?? "",
    units: info.units ?? "",
    frequency: info.frequency ?? "",
    observationStart: info.observation_start ?? "",
    observationEnd: info.observation_end ?? "",
    notes: info.notes ?? ""
  }
}

/** Finalize an observations fetch into a Result. Pure. */
export safe def fredObservationsFinalize(seriesId: string, fetchResult: any): Result {
  return match (fetchResult) {
    success(body) => {
      if (((body.observations ?? null) == null)) {
        return failure("FRED returned no observations for '${seriesId}' (check the series id)")
      }
      return success(parseFredObservations(seriesId, body))
    }
    failure(err) => failure("FRED request failed: ${err}")
  }
}

/** Finalize a series-info fetch into a Result. Pure. */
export safe def fredInfoFinalize(fetchResult: any): Result {
  return match (fetchResult) {
    success(body) => {
      const list = body.seriess ?? []
      if (list.length == 0) {
        return failure("FRED returned no series metadata (check the series id)")
      }
      return success(parseFredInfo(body))
    }
    failure(err) => failure("FRED request failed: ${err}")
  }
}

export safe def fredSeries(seriesId: string, observationStart: string = "", observationEnd: string = "", frequency: string = "", units: string = "", limit: number = 0): Result {
  """
  Fetch a U.S. macroeconomic time-series from FRED by its series id (e.g. "UNRATE" for the
  unemployment rate, "CPIAUCSL" for CPI, "FEDFUNDS" for the fed funds rate). Returns the
  series and a list of { date, value } observations, ordered oldest-first (value is null when
  missing). For the most recent data, set observationStart rather than relying on limit
  (limit caps from the oldest observation). Requires the FRED_API_KEY environment variable.

  @param seriesId - FRED series id, e.g. "UNRATE"
  @param observationStart - Optional earliest date, "YYYY-MM-DD" (empty for no bound)
  @param observationEnd - Optional latest date, "YYYY-MM-DD" (empty for no bound)
  @param frequency - Optional frequency aggregation, e.g. "m", "q", "a" (empty for native)
  @param units - Optional units transform, e.g. "pch" for percent change (empty for "lin")
  @param limit - Optional max observations from the oldest, 0 means no limit
  """
  const apiKey = env("FRED_API_KEY") ?? ""
  if (apiKey == "") {
    return failure("FRED_API_KEY is not set. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html")
  }
  return interrupt std::fred("Fetch this FRED series?", { seriesId: seriesId })
  const path = buildFredObservationsPath(seriesId, apiKey, observationStart, observationEnd, frequency, units, limit)
  return fredObservationsFinalize(seriesId, fredClient(path: path))
}

export safe def fredSeriesInfo(seriesId: string): Result {
  """
  Fetch metadata about a FRED series by its id: its human title, display units, frequency, and
  the date range it covers. Requires the FRED_API_KEY environment variable.

  @param seriesId - FRED series id, e.g. "UNRATE"
  """
  const apiKey = env("FRED_API_KEY") ?? ""
  if (apiKey == "") {
    return failure("FRED_API_KEY is not set. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html")
  }
  return interrupt std::fred("Fetch this FRED series metadata?", { seriesId: seriesId })
  const path = buildFredSeriesPath(seriesId, apiKey)
  return fredInfoFinalize(fredClient(path: path))
}
```

- [ ] **Step 4: Build and run the test to verify it passes**

Run: `make && AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-fred 2>&1 | tee /tmp/fred-test.log`
Expected: PASS. The fixture pins the optional-param fold (`observation_start` and `limit` present; empty `observation_end`/`units` absent), `"."`→null, sparse totality, both finalize branches, and the no-key guard.

- [ ] **Step 5: Register the effect**

Add `std::fred` to the `Network` effect set in `stdlib/capabilities.agency`.

- [ ] **Step 6: Build, lint, format**

Run: `make && pnpm run lint:structure && pnpm run fmt stdlib/data/finance/fred.agency`
Expected: pass; formatter idempotent.

- [ ] **Step 7: Secret-leak verification (spec §8) — a test that actually exercises the key**

The API key travels in the URL. Verify it is not written to statelog/traces in cleartext. Method (statelog output path per `docs/dev/statelog.md`; the `logFile` sink pattern appears in `tests/agency-js/interrupts/interrupt-approve/statelog.log`):

Create `tests/agency/data-finance-fred-leak.agency`:

```
import { fredSeries } from "std::data/finance/fred"

node leakProbe(): string {
  handle {
    const r = fredSeries("UNRATE")
    return "done"
  } with (data) {
    return approve()
  }
}
```

Run (locally, with a *sentinel* key so a real key is never involved):

```bash
FRED_API_KEY=LEAKCHECK_a1b2c3 pnpm run a trace tests/agency/data-finance-fred-leak.agency 2>/dev/null || true
grep -rIn "LEAKCHECK_a1b2c3" traces/ ./*.agencytrace .agency/ 2>/dev/null | tee /tmp/fred-leak.log
```

Expected: **no match** (the interrupt payload carries only `seriesId`, not the key). The fetch itself may fail — the key still flows through the tool-call args and any trace checkpoint that serializes the local `path`/`apiKey`, which is exactly what we are checking. If the sentinel DOES appear, add redaction for the FRED client URL following the codebase's existing statelog-redaction pattern (search `lib/runtime` / `lib/statelogClient.ts` for existing secret redaction), then re-run. Record the result in the commit message.

- [ ] **Step 8: Commit**

```bash
git add stdlib/data/finance/fred.agency stdlib/capabilities.agency tests/agency-js/data-finance-fred tests/agency/data-finance-fred-leak.agency
git commit -F - <<'MSG'
feat(stdlib): add std::data/finance/fred macro connector

FRED connector: env API key + no-key guard, optional query params via a
single appendParam fold, "." -> null values, oldest-first limit semantics.
Pure build/parse/finalize functions unit-tested; FRED_API_KEY verified not
leaked to traces.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 3: DBnomics connector (`std::data/finance/dbnomics`)

Introduces columnar-array zipping (parallel `period[]`+`value[]` → rows) — the declarative idiom EDGAR reuses — with a *total* parser (guards missing `series`).

**Files:**
- Create: `stdlib/data/finance/dbnomics.agency`
- Modify: `stdlib/capabilities.agency` (add `std::dbnomics`)
- Test: `tests/agency-js/data-finance-dbnomics/{agent.agency,test.js,fixture.json,sample-series.json}`

**Interfaces (exported from `std::data/finance/dbnomics`):**
- `type DbnomicsObservation = { period: string; value: number | null }`
- `type DbnomicsSeries = { providerCode: string; datasetCode: string; seriesCode: string; seriesName: string; frequency: string; observations: DbnomicsObservation[] }`
- `safe def buildDbnomicsPath(provider: string, dataset: string, series: string): string`
- `safe def parseDbnomics(raw: any): DbnomicsSeries`
- `safe def dbnomicsFinalize(fetchResult: any): Result`
- `safe def dbnomicsSeries(provider: string, dataset: string, series: string): Result`

- [ ] **Step 1: Write the failing test first**

Create `tests/agency-js/data-finance-dbnomics/sample-series.json` (trimmed from the real `BLS/cu/CUUR0000SA0` capture):

```json
{ "series": { "docs": [ { "provider_code": "BLS", "dataset_code": "cu", "series_code": "CUUR0000SA0", "series_name": "U.S. city average - All items", "@frequency": "monthly", "period": ["2024-11", "2024-12", "2025-01"], "value": [315.6, 316.4, 317.6] } ] } }
```

Create `tests/agency-js/data-finance-dbnomics/agent.agency`:

```
import { buildDbnomicsPath, parseDbnomics, dbnomicsFinalize } from "std::data/finance/dbnomics"

node tBuild(): string {
  return buildDbnomicsPath("BLS", "cu", "CUUR0000SA0")
}

node tParse(raw: any): any {
  return parseDbnomics(raw)
}

node tParseRagged(): any {
  return parseDbnomics({ series: { docs: [{ period: ["2024-11", "2024-12"], value: [315.6] }] } })
}

node tFinalizeEmptyDocs(): string {
  const r = dbnomicsFinalize(success({ series: { docs: [] } }))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}

node tFinalizeNoSeries(): string {
  const r = dbnomicsFinalize(success({ message: "Provider not found" }))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}

node tFinalizeFetchError(): string {
  const r = dbnomicsFinalize(failure("boom"))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}
```

Create `tests/agency-js/data-finance-dbnomics/test.js`:

```javascript
import { tBuild, tParse, tParseRagged, tFinalizeEmptyDocs, tFinalizeNoSeries, tFinalizeFetchError } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const sample = JSON.parse(readFileSync(new URL("./sample-series.json", import.meta.url), "utf8"));

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      path: unwrap(await tBuild()),
      parsed: unwrap(await tParse(sample)),
      ragged: unwrap(await tParseRagged()),
      emptyDocs: unwrap(await tFinalizeEmptyDocs()),
      noSeries: unwrap(await tFinalizeNoSeries()),
      fetchError: unwrap(await tFinalizeFetchError()),
    },
    null,
    2,
  ),
);
```

Create `tests/agency-js/data-finance-dbnomics/fixture.json`:

```json
{
  "path": "series/BLS/cu/CUUR0000SA0?observations=1",
  "parsed": { "providerCode": "BLS", "datasetCode": "cu", "seriesCode": "CUUR0000SA0", "seriesName": "U.S. city average - All items", "frequency": "monthly", "observations": [ { "period": "2024-11", "value": 315.6 }, { "period": "2024-12", "value": 316.4 }, { "period": "2025-01", "value": 317.6 } ] },
  "ragged": { "providerCode": "", "datasetCode": "", "seriesCode": "", "seriesName": "", "frequency": "", "observations": [ { "period": "2024-11", "value": 315.6 }, { "period": "2024-12", "value": null } ] },
  "emptyDocs": "DBnomics returned no series (check the provider/dataset/series codes)",
  "noSeries": "DBnomics returned no series (check the provider/dataset/series codes)",
  "fetchError": "DBnomics request failed: boom"
}
```

The `ragged` case (2 periods, 1 value) is why the zip is index-based: `values[i] ?? null` fills the gap.

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-dbnomics 2>&1 | tee /tmp/dbnomics-test.log`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the connector file**

Create `stdlib/data/finance/dbnomics.agency`:

```
import { fetchJSON } from "std::http"

/** @module
  ## DBnomics — world macroeconomic time-series

  Fetch economic data from [DBnomics](https://db.nomics.world/), an aggregator that re-serves
  80+ statistical providers (Eurostat, IMF, World Bank, OECD, BLS, national statistics offices)
  through one keyless API. Use this connector for *non-U.S.* or cross-country data, or a
  provider FRED does not carry. Each series is addressed by a `provider / dataset / series`
  code triple (browse db.nomics.world to find codes). For U.S. macro prefer
  `std::data/finance/fred`; for news use `std::data/finance/gdelt`.

  Returns a series as a list of `{ period, value }` observations (period like "2025-01"; a
  missing value is null). No API key required.

  ### Usage

  ```ts
  import { dbnomicsSeries } from "std::data/finance/dbnomics"

  node main() {
    const series = dbnomicsSeries("BLS", "cu", "CUUR0000SA0") catch { providerCode: "", datasetCode: "", seriesCode: "", seriesName: "", frequency: "", observations: [] }
    print("${series.seriesName}: ${series.observations.length} observations")
  }
  ```
*/

effect std::dbnomics { provider: string, dataset: string, series: string }

/** A single DBnomics observation. `period` is a label like "2025-01"; `value` may be null. */
export type DbnomicsObservation = {
  period: string;
  value: number | null
}

/** A DBnomics data series with its provider/dataset/series identity and observations. */
export type DbnomicsSeries = {
  providerCode: string;
  datasetCode: string;
  seriesCode: string;
  seriesName: string;
  frequency: string;
  observations: DbnomicsObservation[]
}

const dbnomicsClient = fetchJSON.partial(
  baseUrl: "https://api.db.nomics.world/v22/",
  allowedDomains: ["api.db.nomics.world"]
).preapprove()

/** Build the DBnomics series path (codes are URL-encoded). Pure — no network. */
export safe def buildDbnomicsPath(provider: string, dataset: string, series: string): string {
  const p = encodeURIComponent(provider)
  const d = encodeURIComponent(dataset)
  const s = encodeURIComponent(series)
  return "series/${p}/${d}/${s}?observations=1"
}

/** Reshape a DBnomics series response (zips parallel period/value arrays). Pure — total. */
export safe def parseDbnomics(raw: any): DbnomicsSeries {
  const docs = (raw.series ?? {}).docs ?? []
  const doc = docs[0] ?? {}
  const periods = doc.period ?? []
  const values = doc.value ?? []
  const observations = map(range(periods.length)) as i {
    return { period: periods[i], value: values[i] ?? null }
  }
  return {
    providerCode: doc.provider_code ?? "",
    datasetCode: doc.dataset_code ?? "",
    seriesCode: doc.series_code ?? "",
    seriesName: doc.series_name ?? "",
    frequency: doc["@frequency"] ?? "",
    observations: observations
  }
}

/** Finalize a DBnomics fetch into a Result. Pure — total on missing `series`. */
export safe def dbnomicsFinalize(fetchResult: any): Result {
  return match (fetchResult) {
    success(body) => {
      const docs = (body.series ?? {}).docs ?? []
      if (docs.length == 0) {
        return failure("DBnomics returned no series (check the provider/dataset/series codes)")
      }
      return success(parseDbnomics(body))
    }
    failure(err) => failure("DBnomics request failed: ${err}")
  }
}

export safe def dbnomicsSeries(provider: string, dataset: string, series: string): Result {
  """
  Fetch a macroeconomic time-series from DBnomics by its provider/dataset/series codes
  (e.g. provider "BLS", dataset "cu", series "CUUR0000SA0" for U.S. CPI). Returns the series
  name, frequency, and a list of { period, value } observations. Use for non-U.S. or
  cross-country economic data. No API key required.

  @param provider - DBnomics provider code, e.g. "Eurostat", "IMF", "BLS"
  @param dataset - Dataset code within the provider, e.g. "cu"
  @param series - Series code within the dataset, e.g. "CUUR0000SA0"
  """
  return interrupt std::dbnomics("Fetch this DBnomics series?", {
    provider: provider,
    dataset: dataset,
    series: series
  })
  const path = buildDbnomicsPath(provider, dataset, series)
  return dbnomicsFinalize(dbnomicsClient(path: path))
}
```

Note: `doc["@frequency"]` uses bracket access because `@frequency` is not a bare identifier. If the parser rejects it at Step 4, drop `frequency` from `parseDbnomics`, the `DbnomicsSeries` type, and the fixtures — it is non-essential.

- [ ] **Step 4: Build and run the test to verify it passes**

Run: `make && AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-dbnomics 2>&1 | tee /tmp/dbnomics-test.log`
Expected: PASS. Covers the columnar zip, ragged arrays, missing `series` totality, empty docs, and failure passthrough.

- [ ] **Step 5: Register the effect**

Add `std::dbnomics` to the `Network` effect set in `stdlib/capabilities.agency`.

- [ ] **Step 6: Build, lint, format**

Run: `make && pnpm run lint:structure && pnpm run fmt stdlib/data/finance/dbnomics.agency`
Expected: pass; formatter idempotent.

- [ ] **Step 7: Commit**

```bash
git add stdlib/data/finance/dbnomics.agency stdlib/capabilities.agency tests/agency-js/data-finance-dbnomics
git commit -F - <<'MSG'
feat(stdlib): add std::data/finance/dbnomics world-macro connector

Keyless DBnomics connector; declarative columnar zip of parallel period/value
arrays; total parser/finalize (guards missing series). Pure trio unit-tested
incl. ragged arrays and error bodies.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 4: SEC EDGAR connector (`std::data/finance/edgar`)

Most complex: two fetches (ticker→CIK on `www.sec.gov`, submissions on `data.sec.gov`), a required `User-Agent`, columnar zipping of `filings.recent`, archive-URL construction — all declarative (typed string methods, `find`, `map`/`filter`/`slice`), and a real `edgarSubmissionsFinalize` shared by both orchestrators.

**Files:**
- Create: `stdlib/data/finance/edgar.agency`
- Modify: `stdlib/capabilities.agency` (add `std::edgar`)
- Test: `tests/agency-js/data-finance-edgar/{agent.agency,test.js,fixture.json,sample-tickers.json,sample-submissions.json}`

**Interfaces (exported from `std::data/finance/edgar`):**
- `type Filing = { form: string; filingDate: string; reportDate: string; accessionNumber: string; primaryDocument: string; description: string; url: string }`
- `safe def buildSubmissionsPath(cik10: string): string`
- `safe def buildArchiveUrl(cikNoPad: string, accessionNumber: string, primaryDocument: string): string`
- `safe def parseTickerMap(raw: any, ticker: string): string` (returns 10-digit CIK, or `""`)
- `safe def parseSubmissions(cik10: string, raw: any, formType: string, limit: number): Filing[]`
- `safe def edgarSubmissionsFinalize(cik10: string, formType: string, limit: number, fetchResult: any): Result`
- `safe def edgarFilingsByCik(cik: string, formType: string = "", limit: number = 20): Result`
- `safe def edgarFilings(ticker: string, formType: string = "", limit: number = 20): Result`

- [ ] **Step 1: Write the failing test first**

Create `tests/agency-js/data-finance-edgar/sample-tickers.json` (trimmed from real `company_tickers.json`):

```json
{ "0": { "cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc." }, "1": { "cik_str": 789019, "ticker": "MSFT", "title": "Microsoft Corp" } }
```

Create `tests/agency-js/data-finance-edgar/sample-submissions.json` (trimmed from the real Apple submissions capture):

```json
{ "cik": "0000320193", "name": "Apple Inc.", "tickers": ["AAPL"], "filings": { "recent": { "accessionNumber": ["0000320193-25-000073", "0001140361-26-025622"], "filingDate": ["2025-11-01", "2026-06-17"], "reportDate": ["2025-09-28", "2026-06-15"], "form": ["10-K", "4"], "primaryDocument": ["aapl-20250928.htm", "xslF345X06/form4.xml"], "primaryDocDescription": ["10-K", "FORM 4"] } } }
```

Create `tests/agency-js/data-finance-edgar/agent.agency`:

```
import {
  buildSubmissionsPath,
  buildArchiveUrl,
  parseTickerMap,
  parseSubmissions,
  edgarSubmissionsFinalize
} from "std::data/finance/edgar"

node tSubPath(): string {
  return buildSubmissionsPath("0000320193")
}

node tArchive(): string {
  return buildArchiveUrl("320193", "0000320193-25-000073", "aapl-20250928.htm")
}

node tResolve(raw: any): string {
  return parseTickerMap(raw, "aapl")
}

node tResolveMissing(raw: any): string {
  return parseTickerMap(raw, "NOPE")
}

node tParseAll(raw: any): any {
  return parseSubmissions("0000320193", raw, "", 20)
}

node tParse10K(raw: any): any {
  return parseSubmissions("0000320193", raw, "10-K", 20)
}

node tParseLimit1(raw: any): any {
  return parseSubmissions("0000320193", raw, "", 1)
}

node tParseNoMatch(raw: any): any {
  return parseSubmissions("0000320193", raw, "S-1", 20)
}

node tFinalizeNoFilings(): string {
  const r = edgarSubmissionsFinalize("0000320193", "", 20, success({}))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}

node tFinalizeFetchError(): string {
  const r = edgarSubmissionsFinalize("0000320193", "", 20, failure("boom"))
  if (r is failure(e)) {
    return e
  }
  return "UNEXPECTED"
}
```

Create `tests/agency-js/data-finance-edgar/test.js`:

```javascript
import { tSubPath, tArchive, tResolve, tResolveMissing, tParseAll, tParse10K, tParseLimit1, tParseNoMatch, tFinalizeNoFilings, tFinalizeFetchError } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;
const tickers = JSON.parse(readFileSync(new URL("./sample-tickers.json", import.meta.url), "utf8"));
const submissions = JSON.parse(readFileSync(new URL("./sample-submissions.json", import.meta.url), "utf8"));

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      subPath: unwrap(await tSubPath()),
      archive: unwrap(await tArchive()),
      resolved: unwrap(await tResolve(tickers)),
      resolvedMissing: unwrap(await tResolveMissing(tickers)),
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
```

Create `tests/agency-js/data-finance-edgar/fixture.json`:

```json
{
  "subPath": "submissions/CIK0000320193.json",
  "archive": "https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/aapl-20250928.htm",
  "resolved": "0000320193",
  "resolvedMissing": "",
  "all": [
    { "form": "10-K", "filingDate": "2025-11-01", "reportDate": "2025-09-28", "accessionNumber": "0000320193-25-000073", "primaryDocument": "aapl-20250928.htm", "description": "10-K", "url": "https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/aapl-20250928.htm" },
    { "form": "4", "filingDate": "2026-06-17", "reportDate": "2026-06-15", "accessionNumber": "0001140361-26-025622", "primaryDocument": "xslF345X06/form4.xml", "description": "FORM 4", "url": "https://www.sec.gov/Archives/edgar/data/320193/000114036126025622/xslF345X06/form4.xml" }
  ],
  "tenK": [
    { "form": "10-K", "filingDate": "2025-11-01", "reportDate": "2025-09-28", "accessionNumber": "0000320193-25-000073", "primaryDocument": "aapl-20250928.htm", "description": "10-K", "url": "https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/aapl-20250928.htm" }
  ],
  "limit1": [
    { "form": "10-K", "filingDate": "2025-11-01", "reportDate": "2025-09-28", "accessionNumber": "0000320193-25-000073", "primaryDocument": "aapl-20250928.htm", "description": "10-K", "url": "https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/aapl-20250928.htm" }
  ],
  "noMatch": [],
  "noFilings": "EDGAR returned no filings for CIK 0000320193",
  "fetchError": "EDGAR submissions request failed: boom"
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-edgar 2>&1 | tee /tmp/edgar-test.log`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the connector file**

Create `stdlib/data/finance/edgar.agency`:

```
import { fetchJSON } from "std::http"
import { env } from "std::system"

/** @module
  ## SEC EDGAR — U.S. company filings

  Look up official filings for a U.S.-listed company from the SEC's
  [EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces).
  Use this connector for *authoritative, mandated* facts about one company — its 10-K
  (annual), 10-Q (quarterly), 8-K (material event), and Form 4 (insider trade) filings — the
  slow-moving ground truth. For news or rumor about a company use `std::data/finance/gdelt`;
  for economic numbers use fred/dbnomics.

  Returns a list of filings with form type, filing/report dates, and a direct URL to the
  primary document. No API key required, but the SEC requires a descriptive User-Agent with
  contact info; set the `SEC_USER_AGENT` environment variable to override the default.

  ### Usage

  ```ts
  import { edgarFilings } from "std::data/finance/edgar"

  node main() {
    const filings = edgarFilings("AAPL", "10-K", 5) catch []
    for (filing in filings) {
      print("${filing.filingDate}  ${filing.form}  ${filing.url}")
    }
  }
  ```
*/

effect std::edgar { company: string }

/** One SEC filing. `url` links directly to the primary document. */
export type Filing = {
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  primaryDocument: string;
  description: string;
  url: string
}

const CIK_WIDTH = 10

// SEC requires a descriptive User-Agent with contact info. Read once at module init;
// setting SEC_USER_AGENT after the process starts will not take effect.
const secUserAgent = env("SEC_USER_AGENT") ?? "agency-lang admin@agency-lang.com"

// One preapproved client per host (fetchJSON.partial locks a single baseUrl).
const tickerClient = fetchJSON.partial(
  baseUrl: "https://www.sec.gov/",
  headers: { "User-Agent": secUserAgent },
  allowedDomains: ["www.sec.gov"]
).preapprove()

const submissionsClient = fetchJSON.partial(
  baseUrl: "https://data.sec.gov/",
  headers: { "User-Agent": secUserAgent },
  allowedDomains: ["data.sec.gov"]
).preapprove()

/** Build the submissions path for a 10-digit CIK. Pure — no network. */
export safe def buildSubmissionsPath(cik10: string): string {
  return "submissions/CIK${cik10}.json"
}

/** Build the archive URL for a filing's primary document. Pure — no network. */
export safe def buildArchiveUrl(cikNoPad: string, accessionNumber: string, primaryDocument: string): string {
  const accessionNoDashes = accessionNumber.replaceAll("-", "")
  return "https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accessionNoDashes}/${primaryDocument}"
}

/** Find a ticker in company_tickers.json and return its 10-digit CIK, or "" if absent. Pure. */
export safe def parseTickerMap(raw: any, ticker: string): string {
  const rows = Object.values(raw)
  const want = ticker.toUpperCase()
  const row = find(rows) as r {
    return (r.ticker ?? "").toUpperCase() == want
  }
  if (row == null) {
    return ""
  }
  return "${row.cik_str}".padStart(CIK_WIDTH, "0")
}

/** Reshape a submissions response into Filing[], optionally filtered by form and capped. Pure. */
export safe def parseSubmissions(cik10: string, raw: any, formType: string, limit: number): Filing[] {
  const recent = (raw.filings ?? {}).recent ?? {}
  const forms = recent.form ?? []
  const accessions = recent.accessionNumber ?? []
  const filingDates = recent.filingDate ?? []
  const reportDates = recent.reportDate ?? []
  const primaryDocs = recent.primaryDocument ?? []
  const descriptions = recent.primaryDocDescription ?? []
  // The archive path uses the CIK with leading zeros stripped; Number() does that.
  const cikNoPad = "${Number(cik10)}"
  const rows = map(range(forms.length)) as i {
    return {
      form: forms[i] ?? "",
      filingDate: filingDates[i] ?? "",
      reportDate: reportDates[i] ?? "",
      accessionNumber: accessions[i] ?? "",
      primaryDocument: primaryDocs[i] ?? "",
      description: descriptions[i] ?? "",
      url: buildArchiveUrl(cikNoPad, accessions[i] ?? "", primaryDocs[i] ?? "")
    }
  }
  const filtered = filter(rows) as f {
    return (formType == "") || (f.form == formType)
  }
  if (limit > 0) {
    return filtered.slice(0, limit)
  }
  return filtered
}

/** Finalize a submissions fetch into a Result, shared by both orchestrators. Pure. */
export safe def edgarSubmissionsFinalize(cik10: string, formType: string, limit: number, fetchResult: any): Result {
  return match (fetchResult) {
    success(body) => {
      if (((body.filings ?? null) == null)) {
        return failure("EDGAR returned no filings for CIK ${cik10}")
      }
      return success(parseSubmissions(cik10, body, formType, limit))
    }
    failure(err) => failure("EDGAR submissions request failed: ${err}")
  }
}

export safe def edgarFilingsByCik(cik: string, formType: string = "", limit: number = 20): Result {
  """
  List recent SEC filings for a company by its CIK (Central Index Key). Returns filings with
  form type, filing/report dates, and a direct URL to each primary document. Optionally filter
  by form type (e.g. "10-K", "10-Q", "8-K").

  @param cik - The company CIK, with or without leading zeros
  @param formType - Optional filing form to filter by, e.g. "10-K" (empty for all forms)
  @param limit - Maximum filings to return (default 20)
  """
  const cik10 = cik.padStart(CIK_WIDTH, "0")
  return interrupt std::edgar("Fetch SEC filings for this company?", { company: cik })
  const path = buildSubmissionsPath(cik10)
  return edgarSubmissionsFinalize(cik10, formType, limit, submissionsClient(path: path))
}

export safe def edgarFilings(ticker: string, formType: string = "", limit: number = 20): Result {
  """
  List recent SEC filings for a U.S.-listed company by its ticker symbol (e.g. "AAPL").
  Resolves the ticker to a CIK, then returns filings with form type, filing/report dates, and
  a direct URL to each primary document. Optionally filter by form type (e.g. "10-K", "8-K").

  @param ticker - The company's stock ticker, e.g. "AAPL"
  @param formType - Optional filing form to filter by, e.g. "10-K" (empty for all forms)
  @param limit - Maximum filings to return (default 20)
  """
  return interrupt std::edgar("Fetch SEC filings for this company?", { company: ticker })
  return match (tickerClient(path: "files/company_tickers.json")) {
    success(body) => {
      const cik10 = parseTickerMap(body, ticker)
      if (cik10 == "") {
        return failure("EDGAR: no company found for ticker '${ticker}'")
      }
      const path = buildSubmissionsPath(cik10)
      return edgarSubmissionsFinalize(cik10, formType, limit, submissionsClient(path: path))
    }
    failure(err) => failure("EDGAR ticker lookup failed: ${err}")
  }
}
```

- [ ] **Step 4: Build and run the test to verify it passes**

Run: `make && AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-edgar 2>&1 | tee /tmp/edgar-test.log`
Expected: PASS. Covers CIK padding (`parseTickerMap`), dash-stripping + leading-zero strip in the archive URL, columnar zip, the form filter (match + no-match `[]`), `limit=1`, unknown ticker (`""`), and both finalize branches. If `Number(...)`, `.padStart`, `.replaceAll`, `.toUpperCase`, `.slice`, or `Object.values` is rejected at build, that contradicts `primitiveMembers.ts`/`resolveCall.ts` — re-check the call spelling before working around it.

- [ ] **Step 5: Register the effect**

Add `std::edgar` to the `Network` effect set in `stdlib/capabilities.agency`.

- [ ] **Step 6: Build, lint, format**

Run: `make && pnpm run lint:structure && pnpm run fmt stdlib/data/finance/edgar.agency`
Expected: pass; formatter idempotent.

- [ ] **Step 7: Commit**

```bash
git add stdlib/data/finance/edgar.agency stdlib/capabilities.agency tests/agency-js/data-finance-edgar
git commit -F - <<'MSG'
feat(stdlib): add std::data/finance/edgar SEC filings connector

Two-fetch EDGAR connector: ticker->CIK resolution (find) + submissions, with a
shared edgarSubmissionsFinalize. Declarative columnar zip + filter + slice,
typed string methods, SEC_USER_AGENT header. Pure functions unit-tested incl.
limit, unknown ticker, and form filter.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 5: Interrupt/effect coverage for the remaining connectors, docs, and final verification

The GDELT interrupt test lives in Task 1. Add the same offline interrupt/effect coverage for FRED, DBnomics, and EDGAR (the safety-relevant surface — a typo'd effect label breaks user policies and nothing else catches it), then generate docs and run everything.

**Files:**
- Modify: `tests/agency-js/data-finance-fred/{agent.agency,test.js,fixture.json}`, `tests/agency-js/data-finance-dbnomics/{agent.agency,test.js,fixture.json}`, `tests/agency-js/data-finance-edgar/{agent.agency,test.js,fixture.json}`
- Generated: `docs/site/stdlib/data/finance/*` (via `make doc`)
- Modify: the stdlib docs sidebar/nav

- [ ] **Step 1: Add interrupt/effect assertions to FRED, DBnomics, EDGAR**

For each, add a wrapper node that calls the public function, then interrupt assertions in `test.js`. Note FRED's key check runs *before* the interrupt, so set a dummy key so the interrupt is reached.

FRED — add to `agent.agency`:
```
node callFred(id: string): any {
  return fredSeries(id)
}
```
FRED — add to the top of `test.js` (before the `writeFileSync`):
```javascript
process.env.FRED_API_KEY = "DUMMY"; // so the interrupt is reached (delete happened above for tNoKey)
const fredInt = await callFred("UNRATE");
if (!__fredHas(fredInt)) throw new Error("fredSeries did not interrupt");
if (fredInt.data[0].effect !== "std::fred") throw new Error("wrong FRED effect: " + fredInt.data[0].effect);
if (fredInt.data[0].data.seriesId !== "UNRATE") throw new Error("wrong FRED payload");
await __fredRespond(fredInt.data, [__fredReject()]);
```
and update the FRED test.js import line to also import `{ hasInterrupts as __fredHas, reject as __fredReject, respondToInterrupts as __fredRespond, callFred }`. (Order matters: the `delete process.env.FRED_API_KEY` for `tNoKey` must run *before* `tNoKey()` is called; set the DUMMY key only for the interrupt probe, after `tNoKey()`.)

DBnomics — add to `agent.agency`:
```
node callDbnomics(): any {
  return dbnomicsSeries("BLS", "cu", "CUUR0000SA0")
}
```
DBnomics — add interrupt assertions in `test.js` (import `hasInterrupts`, `reject`, `respondToInterrupts`, `callDbnomics`): assert `effect === "std::dbnomics"` and `data.provider === "BLS"`, then reject.

EDGAR — add to `agent.agency`:
```
node callEdgar(): any {
  return edgarFilings("AAPL")
}
```
EDGAR — add interrupt assertions in `test.js`: assert `effect === "std::edgar"`, `message === "Fetch SEC filings for this company?"`, and `data.company === "AAPL"`, then reject.

The three fixtures are unchanged (interrupt facts are asserted via `throw`, not written to `__result.json`).

- [ ] **Step 2: Re-run all four connector test dirs**

Run:
```
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-gdelt 2>&1 | tee /tmp/t1.log
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-fred 2>&1 | tee /tmp/t2.log
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-dbnomics 2>&1 | tee /tmp/t3.log
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run a test js tests/agency-js/data-finance-edgar 2>&1 | tee /tmp/t4.log
```
Expected: all four PASS (pure-function fixtures match AND interrupt assertions do not throw).

- [ ] **Step 3: Generate stdlib docs**

Run: `make doc 2>&1 | tee /tmp/doc.log`
(`make doc` does `rm -rf docs/site/stdlib/ && pnpm run agency doc stdlib -o docs/site/stdlib/` — the rm-first clears stale pages.)
Expected: four new pages under `docs/site/stdlib/data/finance/`, each showing the `@module` overview, exported types, functions with their docstrings, and auto-computed `Throws:` lines listing the connector's effect.

- [ ] **Step 4: Verify docstrings rendered and add nav entries**

Run: `grep -rl "GDELT\|FRED\|DBnomics\|EDGAR" docs/site/stdlib/data 2>/dev/null` and open one page.
Expected: the module overview (usage example + when-to-use paragraph), function docstrings, and `@param` descriptions are present. Then locate the stdlib sidebar (where `std::weather`, `std::wikipedia` are listed — search `docs/site` for `.vitepress` config or a stdlib index) and add the four `data/finance` pages, grouped.

- [ ] **Step 5: Build the docs site (root-level command)**

Run (from the workspace root, since `pnpm run docs` does not exist in `packages/agency-lang`): `pnpm -C packages/agency-lang/docs/site run build 2>&1 | tee /tmp/docs-build.log`
Expected: the VitePress build succeeds (catches broken links/markup — this is what CI runs).

- [ ] **Step 6: Full lint + commit**

Run: `pnpm run lint:structure`
Then:
```bash
git add tests/agency-js/data-finance-fred tests/agency-js/data-finance-dbnomics tests/agency-js/data-finance-edgar docs/site
git commit -F - <<'MSG'
test+docs: interrupt/effect coverage for fred/dbnomics/edgar + stdlib docs

Offline interrupt tests assert each connector raises its own effect with the
right payload. Generated std::data/finance reference pages + nav.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Self-Review

**1. Spec coverage** (against `2026-07-06-agency-data-connectors-design.md`):
- §4 layout / flat effects → Tasks 1–4; effects registered in `capabilities.agency`. ✓
- §5 recipe (`.partial().preapprove()`, domain effect + interrupt, fetch/parse split, finalize on **every** connector incl. EDGAR) → all four. ✓
- §6.1 GDELT (empty/absent `articles` → `success([])`; rate-limit hint in failure arm; encoded query) → Task 1. ✓
- §6.2 FRED (no-key failure, optional-param fold, `"."`→null, `seriess[0]`, `units`=transform code, oldest-first limit) → Task 2. ✓
- §6.3 EDGAR (User-Agent, two clients, ticker→CIK via `find`, columnar zip, archive URL, shared finalize) → Task 4. ✓
- §6.4 DBnomics (missing-`series` totality, empty docs → failure, period/value zip, ragged arrays) → Task 3. ✓
- §7 exported return types → `export type` in each file, asserted in fixtures. ✓
- §8 config/secrets (FRED key guarded + **real** leak test; effects in `Network`; per-client `allowedDomains`) → Tasks 2/1–4. ✓
- §9 testing (pure-function + offline interrupt/effect + opt-in live smoke; samples are real captures) → Tasks 1–5; GDELT live smoke in Task 1, note that FRED/EDGAR/DBnomics live smokes are deferred (only GDELT is keyless-and-cheap enough to ship a live test now — stated, not silently ✓'d). ⚠ partial (documented).
- §10 docs (@module after imports + docstrings + when-to-use) → each file; generated Task 5. ✓
- §11 build/lint/fmt → every task; `make doc` in Task 5. ✓

**2. Placeholder scan:** No "TBD"/"similar to Task N"; all code, fixtures, and commands inline. Conditional notes (`@frequency` bracket fallback; redaction if the sentinel leaks) give the exact action, not a placeholder.

**3. Type consistency:** Names match across Interfaces blocks, code, and test imports (`buildGdeltPath`/`parseGdelt`/`gdeltFinalize`; `buildFredObservationsPath`/`parseFredObservations`/`fredObservationsFinalize`/`fredInfoFinalize`; `parseDbnomics`/`dbnomicsFinalize`; `parseTickerMap`/`parseSubmissions`/`buildArchiveUrl`/`edgarSubmissionsFinalize`). Fixture field names match each exported `type`.

**Deviations from the review, stated:** (a) URL-join fix applied to GDELT only — FRED/DBnomics/EDGAR joins verified correct (base trailing-slash stripped, paths have leading segments); (b) FRED `limit` documented as oldest-first rather than injecting `sort_order=desc` (avoids inconsistent ordering); (c) mock-HTTP-server claim dropped (no injection point) — coverage is pure trio + offline interrupts + opt-in live; "exactly one prompt per call" is stated as awaiting the fetch mock; (d) project-mandated Co-Authored-By trailer kept; (e) live smokes shipped for GDELT only, with the gap stated rather than marked complete.

**Known execution-time confirmations (flagged, not blockers):** the `@frequency` bracket-key parse; the exact statelog/trace output path for the leak grep; the stdlib docs sidebar file location.
