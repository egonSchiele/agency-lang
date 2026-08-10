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
  parsed-JSON `Result`. It wraps the call in a `handle` block that approves
  the inner `std::http::fetchJSON` interrupt. That approval is what makes a
  connector call surface as ONE prompt ("Search Bluesky for this query?")
  instead of a raw HTTP prompt per request. The approval is a vote, not a
  bypass: an outer handler still receives the fetch interrupt, and if it
  rejects, the reject wins and no request is sent.
  `tests/agency/connector-core.agency` pins this, including the fact that it
  works with the `handle` block in an imported module.
- `connectorError(source, err)` builds the standard failure message.
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
5. **Pure reshape functions** turning raw API JSON into those types. Reshapes
   must be total: read every field with `?? default`, so a malformed response
   produces a well-typed record instead of a crash. Timestamps go through
   `dateStrToEpochMs`.
6. **Pure path builders**, one per endpoint, with `encodeURIComponent` on
   every interpolated value.
7. **Pure finalizers** turning the fetch `Result` into the verb's typed
   `Result` (match on success/failure, reshape on success, `connectorError`
   on failure). These take `any` and live as separate functions so match
   narrowing works after `return interrupt`.
8. **Exported verbs**, each with the same skeleton:

   ```
   export idempotent def bskySearch(query: string, sort: BskySort = "latest", since: number = 0, limit: number = 25): Result<Post[]> raises <std::bluesky, std::http::fetchJSON> {
     """
     Search Bluesky posts by keyword. ...

     @param query - The search keywords
     ...
     """
     const n = clampLimit(limit, 100)
     return interrupt std::bluesky("Search Bluesky for this query?", { op: "search", query: query, since: since, limit: n })
     const result = connectorFetch(BSKY_BASE, BSKY_DOMAINS, buildSearchPath(query, sort, since, n))
     return searchFinalize(result)
   }
   ```

## Conventions

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
  `stdlib/capabilities.agency`. If the connector belongs to a family with
  its own set (like `DataFinance`), add it there too.
- **Docstrings are tool descriptions.** Active voice, every parameter as
  `@param name - description` (bound parameters strip from the description
  when a user calls `.partial()`), no parameter talk outside the `@param`
  lines, no references to other functions. Developer detail goes in doc
  comments instead.
- **Docs are generated.** `make` regenerates `docs/site/stdlib/` from the
  source doc comments; never hand-edit those pages. Link the new page in
  `docs/site/.vitepress/config.mts` (the data section is alphabetical).

## Testing a connector

Connector tests are agency execution tests in `tests/agency/`. No LLM calls,
no network. `tests/agency/bluesky.agency` + `bluesky.test.json` is the
template. Three kinds of tests, all using nodes that call the verbs:

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
3. **The handler contract** is pinned once, in
   `tests/agency/connector-core.agency`, not per connector: an outer handler
   approves the connector effect but rejects the fetch, proving the fetch
   interrupt is visible outside the module and the reject wins.

## Updating an existing connector

- Adding a verb: follow the skeleton in item 8, reuse the module's existing
  effect, and extend the payload only with fields a handler needs. Add a
  payload test and a mocked reshape test for the new verb.
- Changing the payload: existing handlers match on `intr.effect` and read
  `intr.data` fields, so only ADD fields, never rename or remove them.
- Any stdlib `.agency` change requires `make`.

## Porting an old connector to the core

hackernews, yc, and wikidata predate the core and carry their own copies of
the fetch wrapper and error formatter. To port one: replace `<x>Fetch` with
`connectorFetch`, `<x>Error` with `connectorError("<Source>", err)`, and
`capLimit` with `clampLimit`; behavior is identical, so no test changes are
expected beyond adding the tests the connector never had.
