# Writing a data connector

A data connector is a stdlib module that reads a public data source: Hacker
News, Bluesky, GDELT, and the rest of `stdlib/data/`. Connectors are pure
Agency files. They have no TypeScript backing; they call `fetchJSON` from
`std::http` and reshape what comes back.

This doc explains the anatomy of a connector, the conventions every connector
follows, and how to test one. The reference implementation is
`stdlib/data/social/bluesky.agency`. It was written as the template, so when
this doc and that file disagree, the file is probably right and this doc needs
updating.

## The shared core

`stdlib/data/connector.agency` holds the plumbing every connector needs.
Import it; never call `fetchJSON` directly from a connector.

- `connectorFetch(base, domains, path)` fetches a path and returns the
  parsed-JSON `Result`. It pre-approves nothing: calling it directly raises
  the same `std::http::fetchJSON` interrupt as `fetchJSON`, so the helper is
  safe to have exported. Connector verbs approve it at the call site —
  `connectorFetch(...) with approve` — after raising their own connector
  effect. That call-site approval is what makes a connector call surface as
  ONE prompt ("Search Bluesky for this query?") instead of a raw HTTP prompt
  per request, and it is a vote, not a bypass: an outer handler still
  receives the fetch interrupt, and if it rejects, the reject wins and no
  request is sent. `tests/agency/connector-core.agency` pins this. Never
  write a connector verb that calls `connectorFetch` without having raised
  the connector's effect first — the `with approve` is only legitimate
  because the connector-level interrupt already gated the call.
- `connectorError(source, err)` builds the standard failure message for a
  failed fetch.
- `shapeError(source, endpoint, err)` builds the failure message for a
  response that failed wire-shape validation. The validation error it embeds
  is Zod's issue list, which names each mismatched path and what was expected
  there, so the message alone is enough to diagnose API drift.
- `clampLimit(n, cap)` clamps a limit into `[0, cap]`. Connectors clamp
  out-of-range limits instead of rejecting them.
- `dateStrToEpochMs(iso)` converts an ISO 8601 string to epoch milliseconds,
  returning 0 when the string does not parse. Use it in reshapes so they
  stay total.

## Anatomy of a connector

Using bluesky.agency as the running example, a connector file contains, in
order:

1. **A module-level doc comment** (`/** @module ... */`). Explain what the
   source is, note that no API key is needed (if true), show a usage example,
   and show a partial-application example. Shaping connector tools with
   `.partial()` before handing them to an LLM is the expected pattern, so
   demonstrate it.
2. **One effect for the whole connector**, named `std::<source>`:

   ```
   effect std::bluesky { op: string, query: string, since: number, limit: number }
   ```

   The payload always carries `op` (which verb) and `query` (the search
   string, handle, or id). Beyond that, include whatever a handler needs to
   judge the call. For Bluesky that is `since` and `limit`, so a handler can
   see the time window and result volume. Fields that do not apply to an op
   are 0. Never put sensitive data in the payload.
3. **Constants** pinning the base URL and allowed domains:

   ```
   static const BSKY_BASE = "https://public.api.bsky.app/xrpc"
   static const BSKY_DOMAINS = ["public.api.bsky.app"]
   ```

   The domains list goes to `fetchJSON`'s `allowedDomains`, which enforces it
   no matter what a path builder produces.
4. **Exported types** for what the verbs return. Keep them flat and
   email-friendly: the Bluesky `Post` flattens the author to two string
   fields and carries a ready-made `url`.
5. **Wire types**: private types declaring the fields the connector reads
   from each API response (`WirePost`, `WireSearchBody`, ...). Load-bearing
   fields are required; fields whose absence is a normal API state (counts,
   display names) are optional (`likeCount?: number`). Each finalizer
   validates the response body against its wire type with the bang syntax
   (`const validated: WireSearchBody! = body`), so drift on a load-bearing
   field fails loudly with the mismatched paths in the error, instead of
   silently reshaping to defaults. Validation strips unmodeled fields and
   surfaces a missing optional as `null`, so `?? default` still applies
   downstream. This is the only place `any` should appear: the raw body at
   the validation boundary.
6. **Pure reshape functions** turning *validated* wire values into the
   exported types. Optional wire fields default here (`?? 0`, `?? ""`);
   timestamps go through `dateStrToEpochMs`.
7. **Pure path builders**, one per endpoint, with `encodeURIComponent` on
   every interpolated value.
8. **Pure finalizers** turning the fetch `Result` into the verb's typed
   `Result`: match on the fetch, validate the body, reshape on success,
   `connectorError` on a failed fetch, `shapeError` on a failed validation.
   These take `any` and live as separate functions so match narrowing works
   after `return interrupt`.
9. **Exported verbs**, each with the same skeleton:

   ```
   export idempotent def bskySearch(query: string, sort: BskySort = "latest", since: number = 0, limit: number = 25): Result<Post[]> raises <std::bluesky, std::http::fetchJSON> {
     """
     Search Bluesky posts by keyword. ...

     @param query - The search keywords
     ...
     """
     const n = clampLimit(limit, 100)
     return interrupt std::bluesky("Search Bluesky for this query?", { op: "search", query: query, since: since, limit: n })
     const result = connectorFetch(BSKY_BASE, BSKY_DOMAINS, buildSearchPath(query, sort, since, n)) with approve
     return searchFinalize(result)
   }
   ```

## Make the Agency surface ergonomic — adapt, don't mirror

The Agency surface should read well to a human and an LLM, even where that
means it no longer matches the raw API 1:1. Convert at the connector
boundary; keep the wire format internal.

- **Numbers that encode meaning become strings.** LittleSis relationship
  categories are `category_id` integers 1..12 on the wire; the connector
  exposes friendly strings (`"ownership"`, `"donation"`) and maps them
  internally.
- **Magic "absent" values (`""`, `-1`, `0`) become `null`, a clean default,
  or a tagged union.** littlesis's `CategoryFilter`
  (`{ type: "all" } | { type: "category", id: number }`) is the reference:
  invalid input is a `failure`, "no filter" and "specific" are explicit
  states, and `match`/`is` force every state to be handled.
- **Flat, named records, not raw envelopes.** Reshape
  `{ data: [{ attributes: {...} }] }` into a flat record with named fields.
- **Encode API quirks in the docstring, not the signature.**

The goal: a user should never need the upstream API docs to use the
connector correctly.

## Conventions

- **Module constants are `static const`.** Base URL, allowed domains, and
  lookup tables are read-only and shared across runs. A plain `const` is a
  global (reinitialized every run, not exportable); `static const`
  initializes once and is deeply immutable — exactly what config wants.
- **Read verbs are `idempotent`.** A connector read is always safe to re-run,
  and the marker tells the model so. (Older docs mention a `safe` keyword;
  it was removed and `idempotent` replaced it.)
- **All times are epoch milliseconds.** Parameters take ms so unit literals
  work at call sites (`since: now() - 1d`). Result fields are normalized to
  ms from the source's native format via `dateStrToEpochMs`. This holds even
  when the source uses another format on the wire. (Known outlier:
  `hackernews.agency`'s `Story.time` is unix seconds; migrating it is a
  pending breaking change.)
- **Enum-like parameters get union types**, not runtime validation:
  `export type BskySort = "latest" | "top"`. The typechecker and the tool
  schema enforce the values, and there is no failure path to write.
- **Limits are clamped, not rejected.** Also pass the clamped value in the
  effect payload, so a handler judges the real request.
- **Register the effect** in the `Network` effect set in
  `stdlib/capabilities.agency` — only the semantic effect;
  `std::http::fetchJSON` is already there. If the connector belongs to a
  family with its own set (like `DataFinance`), add it there too. A cheap
  regression guard: a test node that `raises <Network>` and calls the
  connector fails to compile if the effect is missing from the set.
- **Consider exporting a ready-made policy.** If the connector has natural
  allow/deny defaults, an exported `static const POLICY: Policy`
  (`std::policy`) saves users a hand-written handler, and can gate
  per-operation (via the payload's `op`), per-domain, or per-method
  (the fetch payload carries `{ baseUrl, path, method }`).
- **Docstrings are tool descriptions.** Active voice, every parameter as
  `@param name - description` (bound parameters strip from the description
  when a user calls `.partial()`), no parameter talk outside the `@param`
  lines, no references to other functions. Developer detail goes in doc
  comments instead.
- **Docs are generated.** `make` regenerates `docs/site/stdlib/` from the
  source doc comments; never hand-edit those pages. Link the new page in
  `docs/site/.vitepress/config.mts` (the data section is alphabetical).

## Runtime gotchas (compile-clean ≠ runtime-correct)

Two things compile without error but break at runtime; only tests catch
them.

1. **Bind the interrupt-raising call to its own statement.** An
   interrupt-raising call nested in an argument or `match` scrutinee does
   not resume/gate at statement level. Write
   `const r = connectorFetch(...) with approve` then `return finalize(r)`
   — never `return finalize(connectorFetch(...) with approve)`.
2. **Do `Result`-consuming work before `return interrupt`.** A `match` or
   `.value` over a typed `Result` placed after a `return interrupt`
   statement fails to narrow. Validate and unwrap before the interrupt
   (also better UX: bad input fails fast without prompting), and put
   post-fetch matching in a separate helper taking `any` (the `*Finalize`
   shape).

## Testing a connector

Two test styles exist; both run offline with no LLM.

**Agency execution tests** (`tests/agency/`): the bluesky template
(`tests/agency/bluesky.agency` + `bluesky.test.json`). Four kinds of tests,
all using nodes that call the verbs:

1. **Payload test.** A handler rejects the connector effect with a string
   composed from `intr.data`, and the node asserts the failure contains the
   expected values. This pins the effect name and payload, including
   clamping (pass `limit: 500`, expect 100 in the payload).
2. **Reshape tests with `fetchMocks`.** A `.test.json` test entry declares
   canned JSON for the endpoint URL; the node approves everything (`with
   approve`) and returns a string projection of the reshaped records. Cover
   the edge cases: missing optional fields defaulting, malformed timestamps
   becoming 0, and any per-source quirks (Bluesky covers the
   `handle.invalid` url fallback and the author-feed `.post` unwrap).
   Because any unmocked fetch throws, these tests also prove which URL the
   verb requested. Two ordered mocks make a parameter-presence test: a
   specific `urlPattern` mock first, a catch-all second, and the returned
   text tells you which one answered (see `searchSendsSinceParam`).
   Mock bodies must satisfy the wire types: include every required field
   even in minimal fixtures.
3. **Shape-drift test.** A mock returns a body missing a load-bearing field;
   the node asserts the failure names the connector, the endpoint, and the
   mismatched path with what was expected (see
   `searchShapeDriftFailsLoudly`). This pins the loud-failure contract that
   makes every production run a drift canary.
4. **The handler contract** is pinned once, in
   `tests/agency/connector-core.agency`, not per connector: an outer handler
   approves the connector effect but rejects the fetch, proving the fetch
   interrupt is visible outside the verb's call-site `with approve` and the
   reject wins.

**Agency-js tests** (`tests/agency-js/data-*/`): the older connectors'
style — an `agent.agency` of node wrappers, a `test.js` of assertions, a
`fixture.json`, and captured `sample-*.json` API responses (prefer a real
captured body over a hand-authored one; a wrong field path otherwise ships
green). `import test { ... }` imports private defs for direct testing.
Two patterns to know:

- **Surfacing the fetch offline.** To prove the fetch effect escapes with
  the right URL without any network, a wrapper node `propagate()`s
  `std::http::fetchJSON` — propagate beats the verb's call-site approve, so
  the interrupt surfaces to the harness, which never approves it. See
  `callGdeltPropagateFetch` in `tests/agency-js/data-news-gdelt/`.
- **The live tier.** Each connector has a `*-live/` sibling gated on
  `AGENCY_LIVE_TESTS` (a vacuous pass by default, so ordinary CI never hits
  the network). The weekly `live-api-tests.yml` workflow runs them all with
  the gate set and files a tracking issue on failure — every connector
  should ship one so shape drift gets noticed within a week.

## Updating an existing connector

- Adding a verb: follow the skeleton in item 9, reuse the module's existing
  effect, and extend the payload only with fields a handler needs. Add a
  payload test and a mocked reshape test for the new verb.
- Changing the payload: existing handlers match on `intr.effect` and read
  `intr.data` fields, so only ADD fields, never rename or remove them.
- Any stdlib `.agency` change requires `make`.

## Checklist

- [ ] `static const` for base URL, allowed domains, lookup tables
- [ ] `effect std::<name>` with `op` + `query` + whatever handlers judge; no secrets in the payload
- [ ] Ergonomic types at the boundary (strings/tagged unions, not raw API sentinels)
- [ ] Wire types; finalizers validate with `!` and fail via `shapeError`
- [ ] Pure builders (`encodeURIComponent` everything) / reshapes / typed finalizers; source-specific hint in the error message if there is one
- [ ] Verbs: validate → interrupt → `connectorFetch(...) with approve` on its own statement → finalize; `idempotent`; times in epoch ms
- [ ] Effect registered in `Network` (+ family set if any)
- [ ] Tests: payload, mocked reshapes, shape-drift; consider a `*-live/` tier
- [ ] `make`; nav entry in `docs/site/.vitepress/config.mts`

## History

Every connector in `stdlib/data/` goes through `connectorFetch`. The
connectors that predate the core (hackernews, yc, wikidata, littlesis,
usaspending) were ported off their private copies of the fetch wrapper, and
the finance connectors (gdelt, fred, dbnomics, edgar), which used to raise a
second `std::http::fetchJSON` prompt on every call, now approve the fetch at
the call site like everyone else — the connector's own effect is the single
user-facing gate. Connectors with a source-specific failure hint (yc,
wikidata, littlesis, usaspending) keep their own error formatter instead of
`connectorError`; that hint is information, not plumbing.
