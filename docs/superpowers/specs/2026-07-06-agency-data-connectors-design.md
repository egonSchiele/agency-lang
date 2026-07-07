# Design: `std::data/finance/*` evidence connectors

- **Date:** 2026-07-06
- **Status:** Approved design, ready for implementation plan
- **Author:** Aditya (with Claude)

## 1. Context and motivation

We want to eventually build a **calibrated event-forecasting agent** in Agency — the
architecture with the strongest real-world track record (Preseen, FutureSearch), where
the agent answers a *resolvable* question ("Will the Fed cut rates in September?", "Will
company X beat earnings?") with a **probability + reasoning**, rather than predicting raw
prices. The research surprise is that the core pipeline is not exotic: FutureSearch's
edge comes from a scaffolded research loop that reads many *ordinary* sources, then a
calibration step — *scaffolding is worth ~9 months of base-model progress*.

A forecaster is only as good as the evidence it can reach. So the **first phase** — this
spec — is purely the **evidence layer**: a small family of standard-library connectors
that fetch real-world data. The forecasting agent, prediction-market integration, and any
unified "evidence" abstraction are explicitly **later phases** (see §12).

This phase adds **four connectors**, all free and (mostly) keyless:

| Module | Source | Kind | Auth |
|---|---|---|---|
| `std::data/finance/gdelt` | [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) | News articles | none |
| `std::data/finance/fred` | [FRED](https://fred.stlouisfed.org/docs/api/fred/) | Macro time-series | free API key |
| `std::data/finance/edgar` | [SEC EDGAR](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) | Company filings | none (User-Agent required) |
| `std::data/finance/dbnomics` | [DBnomics](https://db.nomics.world/) | Macro time-series (aggregator of 80+ providers) | none |

### When to use which source

The four split along two axes — **documents vs. numbers**, and **what entity they describe** — which
is exactly why the spec keeps their return shapes distinct (§7) rather than unifying them:

|  | Text / documents | Numeric time-series |
|---|---|---|
| **World / economy** | **GDELT** (news coverage) | **FRED**, **DBnomics** (economic statistics) |
| **A specific company** | **SEC EDGAR** (official filings) | *(none in v1 — Finnhub, later)* |

- **GDELT — "what is the world reporting, right now?"** Real-time, qualitative, fast-moving news/narrative
  and sentiment. Tells you what's being *said*, not what's true. Reach for it for current events, public
  attention, emerging signals.
- **SEC EDGAR — "what has this company officially disclosed?"** Authoritative, legally-mandated *ground truth*
  about one U.S.-listed company: 10-K (annual), 10-Q (quarterly), 8-K (material event), Form 4 (insider trade).
  Slow-moving and precise — the opposite of GDELT.
- **FRED — "what are the U.S. economic numbers?"** The curated gold standard for U.S. macro (rates, CPI,
  unemployment, GDP). One clean API, addressed by `series_id`; needs a free key.
- **DBnomics — "the same kind of numbers, but for the whole world."** An aggregator re-serving 80+ providers
  (Eurostat, IMF, World Bank, OECD, BLS, national statistics offices), no key, addressed by
  `provider/dataset/series`.

**FRED vs. DBnomics (the one real overlap):** both are economic time-series. Rule of thumb — **U.S. indicator →
FRED** (cleaner labels, curated); **foreign / cross-country / obscure provider → DBnomics** (breadth). They
overlap (e.g. both surface BLS CPI), so the forecaster reaches for FRED first on U.S. questions and falls back
to DBnomics otherwise.

**In practice a forecast pulls from several at once** — that is the point of the evidence layer:

> *"Will the Fed cut rates in September?"* → **FRED** (current rate, latest CPI/unemployment — the hard data) +
> **GDELT** (this week's Fed commentary and coverage) + *(later)* prediction-market price (crowd anchor).

> *"Will Nvidia beat earnings next quarter?"* → **EDGAR** (recent 10-Q/10-K/8-K — company facts) + **GDELT**
> (demand/supply/competitor news) + **FRED/DBnomics** (macro backdrop).

The mnemonic: **GDELT for the narrative, EDGAR for company facts, FRED for U.S. macro, DBnomics for the rest of
the world's macro.**

## 2. Goals and non-goals

**Goals**
- Four importable stdlib modules that each turn a real HTTP+JSON API into typed Agency values.
- Idiomatic, single-file, **pure Agency** — no per-connector TypeScript backing.
- Each connector is network-egress-gated with a **source-specific approval interrupt** and a
  restricted `allowedDomains`, consistent with the rest of the stdlib's safety story.
- Faithful, well-typed return shapes with clear `Result` failures.
- Fully tested: unit tests that **mock `fetch`** (see §9 — assumed test-framework capability),
  plus opt-in live-network integration tests.
- Generated stdlib reference docs via `agency doc`.

**Non-goals (explicitly deferred)**
- The forecasting agent itself.
- Prediction-market connectors (Kalshi/Polymarket/Manifold/Metaculus) and Finnhub — later phases.
- A **unified `Evidence` envelope** across sources. These four are heterogeneous (two are
  document sources, two are numeric time-series); forcing one shape now would be a lossy
  abstraction built before its consumer exists. Normalization belongs to the forecaster layer.
- General web search (blocked on Agency's search-tool story) and social-sentiment sources.
- Response caching, retries/backoff, and pagination beyond a single request (may be added
  later; not required for v1).

## 3. Design principles

1. **Pure Agency, one file per connector.** Error handling (`Result`/`try`/`catch`/`|>`/`match`),
   reshaping (`map`/`filter`/`reduce`/`groupBy`, destructuring, `map(arr) as x { … }` blocks), and
   dynamic-JSON navigation are all first-class in the language. No connector here needs regex-heavy
   munging or CSV, so none needs a TS helper. (Reserve TS-backing only if a *future* source forces it.)
2. **Constrained client via `.partial().preapprove()`.** Each module builds one module-level HTTP
   client with `fetchJSON.partial(baseUrl:…, allowedDomains:[…]).preapprove()`. `.preapprove()`
   silences the generic `std::http::fetchJSON` prompt so the user sees exactly one, *source-specific*
   approval prompt (mirrors how `weather` raises only `std::weather`). `allowedDomains` hard-restricts
   egress to the source's host(s).
3. **Source-specific effect + interrupt.** Each connector raises its own effect (`std::gdelt`,
   `std::fred`, `std::edgar`, `std::dbnomics`) as its first statement, so users can write policies
   like "allow FRED, block EDGAR". No `raises` clause on the public functions (matches `weather.agency`,
   which lets the auto try/catch and preapproved inner fetch compose cleanly).
4. **Fetch/parse split.** Each connector separates the network call from a **pure, exported
   `parseX(raw)` function** that reshapes raw JSON into the typed return. This keeps reshaping logic
   directly unit-testable (independent of the fetch mock) and reads cleanly.
5. **Faithful per-source types.** Each connector returns its own shape (below). No premature unification.

## 4. Module layout and naming

```
stdlib/data/finance/gdelt.agency
stdlib/data/finance/fred.agency
stdlib/data/finance/edgar.agency
stdlib/data/finance/dbnomics.agency
```

Imported as `std::data/finance/gdelt`, `std::data/finance/fred`, `std::data/finance/edgar`, `std::data/finance/dbnomics`
(subpath modules like `std::web/search`; explicit import, **not** auto-imported).

**Effects** (declared in each module, registered in the `Network` effect set of
`std::capabilities` — see §8):
`std::gdelt`, `std::fred`, `std::edgar`, `std::dbnomics`.

## 5. The common connector recipe

Every connector follows this shape (GDELT shown; syntax verified against `stdlib/index.agency`,
`stdlib/auth/oauth.agency`, `stdlib/weather.agency`, `stdlib/ui.agency`):

```
import { fetchJSON } from "std::http"

effect std::gdelt { query: string }

// One module-level constrained client. `.preapprove()` suppresses the inner
// std::http::fetchJSON prompt so only our std::gdelt prompt reaches the user.
const gdeltClient = fetchJSON.partial(
  baseUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
  allowedDomains: ["api.gdeltproject.org"],
).preapprove()

type NewsArticle = {
  title: string;
  url: string;
  domain: string;
  language: string;
  sourceCountry: string;
  seenDate: string
}

// Pure, network-free → unit-testable directly with saved JSON fixtures.
// `?? []` guards an absent field (e.g. a rate-limit body with no `articles`);
// `catch` is reserved for unwrapping Result values, not plain field access.
export def parseGdelt(raw: any): NewsArticle[] {
  const articles = raw.articles ?? []
  return map(articles) as a {
    return {
      title: a.title,
      url: a.url,
      domain: a.domain,
      language: a.language,
      sourceCountry: a.sourcecountry,
      seenDate: a.seendate
    }
  }
}

export def gdeltNews(query: string, maxRecords: number = 25, timespan: string = "3d"): Result {
  """
  Search worldwide online news coverage for a query via GDELT DOC 2.0. Returns
  recent matching articles (title, URL, source domain, language, source country,
  and the GDELT seen-date). Use this to gather news evidence about an event,
  company, or topic.

  @param query - Search terms in GDELT DOC query syntax (e.g. "Federal Reserve rate cut")
  @param maxRecords - Maximum number of articles to return, 1-250 (default 25)
  @param timespan - How far back to search, e.g. "3d", "1w", "24h" (default "3d")
  """
  return interrupt std::gdelt("Search GDELT news for this query?", { query: query })
  const path = "?query=${query}&mode=artlist&format=json&maxrecords=${maxRecords}&timespan=${timespan}"
  const raw = gdeltClient(path: path)
  if (raw is failure(err)) {
    return failure("GDELT request failed: ${err}")
  }
  return success(parseGdelt(raw.value))
}
```

Key mechanics this relies on (all confirmed in-repo):
- `fetchJSON` returns a `Result` whose success value is parsed JSON; `.partial()` /
  `.preapprove()` exist and compose.
- `map(arr) as x { … }` block form and `\x -> expr` lambdas are supported (JS `=>` arrows are not).
- `env(name): string | null` for secrets/config.
- `return interrupt eff(msg, data)` as the first statement is the standard approval-gate/resume
  pattern; execution continues past it once approved.

## 6. Per-connector specifications

### 6.1 `std::data/finance/gdelt` — news

- **When to use:** current events, public attention, emerging signals, sentiment — "what is the world reporting
  right now?" Qualitative and fast-moving. (Contrast: EDGAR for official company facts.)
- **Endpoint:** `GET https://api.gdeltproject.org/api/v2/doc/doc`
- **Params used:** `query`, `mode=artlist`, `format=json`, `maxrecords` (1–250), `timespan`.
- **Response:** `{ articles: [{ url, url_mobile, title, seendate, socialimage, domain, language, sourcecountry }] }`.
  `seendate` is a `YYYYMMDDTHHMMSSZ` string (kept as-is in v1; a `parseSeenDate` helper is a possible extra).
- **Functions:**
  - `gdeltNews(query, maxRecords=25, timespan="3d"): Result<NewsArticle[]>`
  - `parseGdelt(raw): NewsArticle[]` (pure)
- **Return type:** `NewsArticle = { title, url, domain, language, sourceCountry, seenDate }`.
- **Edge cases / notes:**
  - **Rate limit:** GDELT asks for ≤ 1 request / 5s; exceeding it returns a *non-JSON plain-text*
    warning, not JSON. `parseGdelt` must not crash on that — `raw.articles catch []` yields an empty
    list, and the connector should detect a non-object/absent-`articles` body and return a `failure`
    with the server text so the caller sees the rate-limit reason. **Document the rate limit in the docstring.**
  - Empty result set → `success([])`, not a failure.

### 6.2 `std::data/finance/fred` — macroeconomic time-series

- **When to use:** U.S. economic indicators by name (fed funds rate, CPI/inflation, unemployment, GDP). The
  curated gold standard for U.S. macro. (Contrast: DBnomics for non-U.S. / cross-country data.)
- **Base:** `https://api.stlouisfed.org/fred/`
- **Auth:** free key via `env("FRED_API_KEY")`. If null/empty → `failure("FRED_API_KEY is not set. Get a
  free key at https://fred.stlouisfed.org/docs/api/api_key.html")`. **The key is a secret:** it goes in the
  query string but MUST NOT appear in the interrupt payload (payload carries only `seriesId`), and we should
  confirm it is not surfaced in statelog for the outbound URL (verify during implementation; see §8).
- **Endpoints/functions:**
  - `fredSeries(seriesId, observationStart="", observationEnd="", frequency="", units="", limit=0): Result<FredSeries>`
    → `GET fred/series/observations?series_id=…&api_key=…&file_type=json` plus optional
    `observation_start`, `observation_end`, `frequency`, `units`, `limit`.
    Response `{ units, observations: [{ date, value }] }`. `value` is a **string**, and a missing value is
    the string `"."` — `parseFred` converts to `number | null` (`"."` → `null`), never crashes. Note the
    response `units` field is the requested **units transform code** (e.g. `"lin"`, `"pch"`), *not* the series'
    human display units — for the display label ("Percent") use `fredSeriesInfo` (whose `seriess[0].units` is
    the display label). `FredSeries.units` is documented as the transform code accordingly.
    Also note FRED returns observations **oldest-first**; `limit` caps from the oldest, so callers wanting
    recent data should set `observationStart` rather than relying on `limit`.
  - `fredSeriesInfo(seriesId): Result<FredSeriesInfo>`
    → `GET fred/series?series_id=…&api_key=…&file_type=json`. Response `{ seriess: [ { id, title, units,
    frequency, observation_start, observation_end, notes } ] }` (note the double-s `seriess`); take `[0]`,
    fail if empty.
  - `parseFredObservations(raw): FredSeries`, `parseFredInfo(raw): FredSeriesInfo` (pure).
- **Return types:**
  - `FredObservation = { date: string; value: number | null }`
  - `FredSeries = { seriesId: string; units: string; observations: FredObservation[] }`
  - `FredSeriesInfo = { id, title, units, frequency, observationStart, observationEnd, notes }`
- **Empty/omitted params:** `""`/`0` sentinels mean "unset" (Agency has no `undefined` args); the connector
  only appends a query param when its value is non-empty.

### 6.3 `std::data/finance/edgar` — SEC filings

- **When to use:** official, authoritative facts about **one U.S.-listed company** — its 10-K/10-Q/8-K/Form 4
  filings and material events. Slow-moving ground truth. (Contrast: GDELT for news/rumor about a company.)
- **Auth:** none, but SEC **requires a `User-Agent` header** with contact info (403 otherwise). Source it from
  `env("SEC_USER_AGENT")`, defaulting to `"agency-lang (https://agency-lang.com)"`.
- **Two hosts** → the module builds **two preapproved clients** (both raise `std::edgar`), because
  `fetchJSON.partial` locks a single `baseUrl`:
  - `tickerClient` → `https://www.sec.gov` (for `company_tickers.json`), `allowedDomains: ["www.sec.gov"]`.
  - `submissionsClient` → `https://data.sec.gov` (for submissions), `allowedDomains: ["data.sec.gov"]`.
  Filing **archive links are constructed strings** returned to the caller, not fetched here, so they need no client.
- **Functions:**
  - `edgarFilings(ticker, formType="", limit=20): Result<Filing[]>` — resolve `ticker`→CIK, fetch submissions,
    reshape, optionally filter by `formType` (e.g. `"10-K"`, `"8-K"`), cap at `limit`.
  - `edgarFilingsByCik(cik, formType="", limit=20): Result<Filing[]>` — same, skipping ticker resolution.
  - `parseSubmissions(raw): Filing[]` (pure — see the columnar note).
  - (internal) `resolveCik(ticker): Result<string>` — fetch `https://www.sec.gov/files/company_tickers.json`
    (`{ "0": { cik_str, ticker, title }, … }`), find matching ticker (case-insensitive), zero-pad `cik_str`
    to 10 digits.
- **Submissions endpoint:** `GET https://data.sec.gov/submissions/CIK{10-digit}.json`. Top-level
  `{ cik, name, tickers, …, filings: { recent: { … } } }`. **`filings.recent` is columnar** — parallel arrays
  `accessionNumber[]`, `filingDate[]`, `reportDate[]`, `form[]`, `primaryDocument[]`, `primaryDocDescription[]`
  (all same length). `parseSubmissions` **zips** these arrays index-by-index into row objects (a clean use of
  `range(n)` + `map`).
- **Archive URL construction:** for each filing,
  `https://www.sec.gov/Archives/edgar/data/{cikNoLeadingZeros}/{accessionNoDashesRemoved}/{primaryDocument}`.
- **Return type:**
  `Filing = { form: string; filingDate: string; reportDate: string; accessionNumber: string;
  primaryDocument: string; description: string; url: string }`.
- **Edge cases:** unknown ticker → `failure`; company with no filings → `success([])`; `formType=""` means
  no filter.

### 6.4 `std::data/finance/dbnomics` — aggregated macro time-series

- **When to use:** non-U.S. or cross-country economic data, or a statistical provider FRED does not carry
  (Eurostat, IMF, World Bank, OECD, national offices). Breadth over curation. (Contrast: FRED for U.S. macro.)
- **Endpoint:** `GET https://api.db.nomics.world/v22/series/{provider}/{dataset}/{series}?observations=1`
- **Response (confirmed live):** `{ _meta, provider, dataset, errors, series: { docs: [ { provider_code,
  dataset_code, dataset_name, series_code, series_name, "@frequency", period: [], period_start_day: [],
  value: [] } ] } }`. `period[]` and `value[]` are parallel arrays.
- **Functions:**
  - `dbnomicsSeries(provider, dataset, series): Result<DbnomicsSeries>` — take `series.docs[0]`, fail if empty,
    zip `period[]`+`value[]` into observations.
  - `parseDbnomics(raw): DbnomicsSeries` (pure).
- **Return type:**
  `DbnomicsObservation = { period: string; value: number | null }`;
  `DbnomicsSeries = { providerCode, datasetCode, seriesCode, seriesName, frequency, observations: DbnomicsObservation[] }`.
  (Use `period_start_day` too if useful; `period` like `"2025-01"` is the primary label.)
- **Edge cases:** missing values in `value[]` can be `null` already → pass through; empty `docs` → `failure`.

## 7. Return types — summary

All types are declared inside their module (exported so callers and tests can name them):

- GDELT: `NewsArticle`
- FRED: `FredObservation`, `FredSeries`, `FredSeriesInfo`
- EDGAR: `Filing`
- DBnomics: `DbnomicsObservation`, `DbnomicsSeries`

## 8. Shared concerns

**Config & secrets**
- FRED: `env("FRED_API_KEY")`, required; clear failure if unset. Key never placed in interrupt payload.
- EDGAR: `env("SEC_USER_AGENT")` with a sensible default.
- GDELT, DBnomics: no config.
- **Secret-leak check (implementation task):** verify the FRED `api_key` in the outbound URL is not written to
  statelog/traces in cleartext; if it is, redact the query string for FRED's client (there is precedent for
  statelog redaction in the codebase).

**Effects & capabilities**
- Add `std::gdelt`, `std::fred`, `std::edgar`, `std::dbnomics` to the `Network` effect set in
  `stdlib/capabilities.agency`, so existing network policies keep working and users can group them.

**Approval UX**
- Exactly one source-specific prompt per call (domain effect raised; inner `fetchJSON` preapproved).
- `allowedDomains` restricts egress even if a bug constructs a wrong URL.

**Error handling**
- Every public function returns `Result`. Network/parse errors become `failure` with an actionable message.
- Pure `parseX` functions must be **total** on malformed input (use `?? default` / guards on field access;
  never index into a possibly-missing field without a fallback).

## 9. Testing

Assumes the **new fetch-mocking capability** in the Agency test framework (being built in parallel), letting a
test stub HTTP responses so `fetchJSON` returns canned JSON without real network.

**Unit tests (mocked fetch), per connector** — in `tests/agency/` or `tests/agency-js/`:
- Happy path: mock a realistic response (from a saved fixture) → assert the exact reshaped typed output.
- **URL/param construction:** assert the request URL/path the connector builds (query encoding, `maxRecords`,
  FRED optional params only appended when set, EDGAR 10-digit CIK padding + archive URL, DBnomics path).
- Error paths: HTTP failure → `failure`; FRED missing key → specific failure; GDELT rate-limit plain-text body
  → failure carrying the server text; EDGAR unknown ticker → failure; empty result sets → `success([])`.
- Edge parsing: FRED `"."` → `null`; EDGAR columnar zip alignment; `formType` filter; DBnomics `docs[0]` empty.

**Pure-function tests:** call `parseGdelt` / `parseFredObservations` / `parseSubmissions` / `parseDbnomics`
directly with fixtures (no fetch needed) — the primary guard on reshaping logic.

**Fixtures:** saved sample JSON per source under a `tests/.../fixtures/` dir (trimmed real responses; the EDGAR
Apple and DBnomics BLS/CPI responses captured during design are good seeds).

**Live integration tests (opt-in, off by default):** one real call per source behind an env flag / tag so CI
doesn't depend on external services or the GDELT rate limit. FRED/EDGAR live tests need a key / UA in the
environment.

## 10. Documentation

- Module-level `/** @module … */` doc comment + per-function docstrings in each `.agency` file. Docstrings double
  as LLM tool descriptions, so they must be accurate and user-facing.
- **Each module states when to reach for it vs. the others** (from §1 "When to use which source"): the module doc
  comment carries the one-line positioning ("news/narrative", "U.S. macro", "company filings", "world macro") and
  the FRED↔DBnomics distinction, so both the generated stdlib pages *and* the LLM tool descriptions help pick the
  right source. Keep these lines short — the LLM sees them on every call.
- Run `agency doc` so generated pages appear under `docs/site/stdlib/data/finance/*`; add nav entries alongside the other
  stdlib modules.
- A short usage example per module (search news / fetch a FRED series / list a company's 10-Ks / fetch a DBnomics
  series).

## 11. Build & tooling

- New stdlib files → **run `make`** (per CLAUDE.md, always build after changing stdlib).
- Run `pnpm run lint:structure` and `pnpm run fmt` on the new files.
- No changes to the compiler/runtime are expected — these are ordinary stdlib modules over existing primitives.

## 12. Future phases (out of scope here)

1. **Prediction-market connectors** (Kalshi/Polymarket/Manifold/Metaculus) — the crowd-price *calibration anchor*.
2. **Finnhub** (one free key) — structured prices/fundamentals/estimates/news.
3. **Unified `Evidence` envelope** — a forecaster-layer normalizer mapping each source into a common shape.
4. **The forecasting agent** — research → (optional debate) → calibrated probability, using these connectors as tools,
   scored against resolved questions via Agency's `eval` / `eval optimize`.
5. General web search; social-sentiment sources; caching/retry/pagination.

## 13. File change list

- **New:** `stdlib/data/finance/gdelt.agency`, `stdlib/data/finance/fred.agency`, `stdlib/data/finance/edgar.agency`,
  `stdlib/data/finance/dbnomics.agency`.
- **New:** unit tests + JSON fixtures per connector (`tests/agency/` or `tests/agency-js/`).
- **Edit:** `stdlib/capabilities.agency` — add the four effects to the `Network` effect set.
- **Generated:** `docs/site/stdlib/data/finance/*` via `agency doc`; stdlib nav updated.
- **Verify:** statelog does not leak the FRED `api_key`.
```
