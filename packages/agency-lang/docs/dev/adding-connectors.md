# Adding a data connector

A **connector** is a stdlib module that wraps a remote HTTP/JSON API as a small set of
Agency functions — e.g. `std::data/finance/gdelt` (news), `std::data/finance/fred` (economic
series), `std::data/finance/edgar` (SEC filings), and `std::data/people/littlesis` (entity /
power-network data). This doc is the connector-specific recipe. For the general "how to add a
stdlib module" rules (docstrings vs doc comments, `safe`, named/default params, TS bindings),
read [`adding-a-module-to-the-agency-stdlib.md`](./adding-a-module-to-the-agency-stdlib.md)
first — this doc assumes it.

The shipped connectors are the reference implementations. `gdelt.agency` is the smallest
"Option A" example; `littlesis.agency` is the most complete and shows every pattern below.
Copy their structure.

---

## The shape of a connector

Split the work into pure pieces and one thin orchestrator per public function. The logic for
*what* (path/shape/result) lives apart from the logic for *how* (the fetch + gating), so you can
change one without touching the other, and unit-test almost everything without a network.

```
one .agency file, in this order:
  import { fetchJSON } from "std::http"       // the network primitive
  /** @module ... */                          // module doc: when to use, usage, gotchas
  effect std::<name> { op: string, ... }      // the connector's own approval effect
  static const <BASE>, <DOMAINS>, <tables>    // config + lookup tables (static!)
  export type <Record>                        // flat, typed output shapes
  export safe def build*Path(...)             // pure URL builders
  export safe def parse*(raw: any)            // pure JSON -> typed reshapers
  <private> def <name>Fetch(path)             // the one fetch + gating helper
  export safe def *Finalize(fetchResult)      // pure Result<fetchbody> -> Result<Record>
  export safe def <name><Op>(...) raises <...> // the public functions
```

Every public function is then a four-liner: validate input → raise the semantic interrupt →
fetch → finalize.

---

## 1. Config and lookup tables: use `static const`

Module-level constants (base URL, allowed domains, id↔name tables) are read-only and shared
across every run. Mark them **`static const`**, not plain `const`. A plain `const` is a *global*
— reinitialized on every run and not exportable; `static const` initializes once, is shared, and
is deeply immutable. See [global vs static](https://agency-lang.com/guide/global-vs-static.html).

```
static const LITTLESIS_BASE = "https://littlesis.org/api"
static const LITTLESIS_DOMAINS = ["littlesis.org"]
static const CATEGORY_NAMES = ["", "position", "education", /* ... */]
```

(Deeply immutable means you can read/`.slice()`/`.indexOf()` a static array but not mutate it in
place — which is exactly what a lookup table wants.)

---

## 2. Make the Agency interface ergonomic — adapt, don't mirror

**The Agency surface should read well to a human and an LLM, even where that means it no longer
matches the raw API 1:1.** Convert at the connector boundary; keep the wire format internal.

- **Numbers that encode meaning → strings.** LittleSis relationship categories are `category_id`
  integers `1..12`; the connector exposes friendly strings (`"ownership"`, `"donation"`) and maps
  them internally. Users read `littlesisConnections(id, "ownership")`, not `(id, 10)`.
- **Empty-string / magic-number "absent" → `null` (or a real option).** If the API uses `""` or
  `-1` to mean "none/all/unknown", take a `null` (or a clean default) in Agency and translate.
- **Sentinels → tagged unions or `Result`.** This is the big one (see §3).
- **Flat, named records, not raw envelopes.** Reshape `{ data: [{ attributes: {...} }] }` into a
  flat `Entity`/`Relationship` with named fields.
- **Encode API quirks in the docstring, not the signature.** e.g. "edges carry entity IDs, not
  names — resolve with `littlesisSearch` first."

The goal: someone using the connector should never need to read the upstream API docs to use it
correctly.

### 3. Prefer tagged unions over sentinel values

Magic returns (`-1` = unknown, `""` = none, `0` = all) are the classic source of connector
confusion — three different "empty"s that a reader has to memorize. Model the states explicitly.

Agency's tagged-union idiom is a **discriminated object union** (matched with `is` / `match`), plus
the built-in `Result` (`success`/`failure`). Example from `littlesis.agency`:

```
export type CategoryFilter = { type: "all" } | { type: "category", id: number }

/** "" (not given) -> all; a valid name -> that category; unknown -> failure. */
export safe def parseCategoryFilter(name: string): Result<CategoryFilter> {
  if (name == "") { return success({ type: "all" }) }
  const idx = CATEGORY_NAMES.indexOf(name)
  if (idx < 1) { return failure("unknown category '${name}'; valid: ${categoryNamesList()}") }
  return success({ type: "category", id: idx })
}
```

The builder then pattern-matches instead of checking `>= 1`:

```
if (filter is { type: "category", id: catId }) { params.push("category_id=${catId}") }
```

Invalid input is a `failure`, "no filter" is `{type:"all"}`, "specific" is `{type:"category", id}`
— no sentinels, and the compiler forces every state to be handled.

---

## 4. Pure builders, parsers, finalizers

These are pure `safe def`s with no network — the bulk of the connector, and almost all of the
test surface.

**Builders** (`build*Path`) turn typed args into a URL path. Build a present-params list and
`join("&")` rather than enumerating every on/off combination:

```
export safe def buildRelationshipsPath(id: number, filter: CategoryFilter, sort: string): string {
  const base = "/entities/${id}/relationships"
  let params: string[] = []
  if (filter is { type: "category", id: catId }) { params.push("category_id=${catId}") }
  if (sort != "") { params.push("sort=${encodeURIComponent(sort)}") }
  if (params.length == 0) { return base }
  return "${base}?${params.join("&")}"
}
```

**Parsers** (`parse*`) reshape the raw JSON into your flat records. Make them **total** — guard
*every* dynamic field with `?? default` so malformed/missing input never throws:

```
export safe def parseEntity(node: any): Entity {
  const safeNode: any = node ?? {}
  const attrs: any = safeNode.attributes ?? {}
  return { id: attrs.id ?? 0, name: attrs.name ?? "", /* ... every field guarded ... */ }
}
```

**Finalizers** (`*Finalize`) turn the fetch `Result` into a typed `Result`, and are where you
attach a user-facing error message. Give them a **specific** return type (`Result<Entity[]>`, not
bare `Result`):

```
export safe def entityListFinalize(fetchResult: any): Result<Entity[]> {
  return match (fetchResult) {
    success(body) => success(parseEntities(body))
    failure(err) => failure(littlesisError(err))
  }
}
```

Put the rate-limit hint in the failure message — it's the most common runtime error:

```
"LittleSis request failed (the API may be rate-limited; HTTP 503 = Rate Limit Exceeded): ${err}"
```

---

## 5. The fetch and interrupt gating

Every connector raises its own **semantic effect** (`effect std::littlesis { op, query }`) so a
user can approve/deny *this connector* specifically. The question is how the underlying HTTP fetch
is gated. There are two patterns; pick deliberately.

### Option A — surface both interrupts (finance connectors)

Call `fetchJSON` from `std::http` directly and declare both effects. The caller sees **two**
prompts: the semantic one and the concrete `std::http::fetchJSON` ("fetch this URL?").

```
export safe def gdeltNews(...): Result<...> raises <std::gdelt, std::http::fetchJSON> {
  """ ...docstring... """
  return interrupt std::gdelt("Search GDELT news for this query?", { query: query })
  const result = fetchJSON(baseUrl: GDELT_BASE, path: buildGdeltPath(...), allowedDomains: GDELT_DOMAINS)
  return gdeltFinalize(result)
}
```

Best when you want a **central egress chokepoint** — every outbound request also flows through
`std::http::fetchJSON`, so one handler can audit/gate all network I/O. Cost: two prompts push
casual users toward blanket-approving `std::http::fetchJSON`.

### Option B — single prompt via internal approve (littlesis)

Call `fetchJSON` inside a private helper whose handler **internally approves** the
`std::http::fetchJSON` interrupt. A caller with no fetch handler sees only **one** prompt (the
semantic effect); the fetch effect **still propagates to every outer handler**, so a governance
handler can still `reject()` / `propagate()` it (those beat the internal `approve()` — see the
[handler rules](https://agency-lang.com/guide/handlers.html)). Because the effect still escapes,
it **stays in the `raises` clause**.

```
def littlesisFetch(path: string): Result raises <std::http::fetchJSON> {
  handle {
    return fetchJSON(baseUrl: LITTLESIS_BASE, path: path, allowedDomains: LITTLESIS_DOMAINS)
  } with (data) {
    if (data.effect == "std::http::fetchJSON") { return approve() }
  }
}
```

Best for single-prompt ergonomics without losing governance. Note: a caller whose handler has a
catch-all `reject()` for unknown effects will still reject the fetch (reject beats approve), so
such a caller must explicitly allow `std::http::fetchJSON`.

### Always

- **Pin the host with `allowedDomains`.** Even with the semantic gate, `allowedDomains` bounds
  where a fetch can go. It's enforced inside `fetchJSON` regardless of which option you pick.
- **Never put secrets in the effect payload** — the payload shows up in prompts and the statelog.

### Give the effect payload a discriminant (`op`)

If the connector exposes several operations under one effect (search / entity / relationships /
connections all raise `std::littlesis`), add an **`op` discriminant** so handlers and `std::policy`
(`stdlib/policy.agency`) rules can gate individual operations without splitting into four effects:

```
effect std::littlesis { op: string, query: string }
// ... interrupt std::littlesis("...", { op: "relationships", query: "${id}" })
```

Then a policy rule can `match: { op: "relationships" }` to allow/deny just that operation.

---

## 6. Public functions: validate before the interrupt

Each public function: **validate input → raise the interrupt → fetch → finalize.** Two subtleties
matter, and both are runtime behaviors the compiler will NOT catch — see Gotchas.

```
export safe def littlesisRelationships(id: number, category: string = "", sort: string = ""):
    Result<Relationship[]> raises <std::littlesis, std::http::fetchJSON> {
  """ ...docstring (becomes the LLM tool description)... """
  // 1. Validate BEFORE the interrupt (fail fast; also see Gotchas #2).
  const filterResult = parseCategoryFilter(category)
  if (filterResult is failure(msg)) { return failure(msg) }
  const filter = filterResult.value
  // 2. Raise the semantic interrupt.
  return interrupt std::littlesis("Fetch relationships for this LittleSis entity?", { op: "relationships", query: "${id}" })
  // 3. Fetch on its OWN statement (Gotchas #1), then finalize.
  const result = littlesisFetch(buildRelationshipsPath(id, filter, sort))
  return relationshipsFinalize(result)
}
```

---

## 7. Register the effect in a capability set

Add the connector's effect to the relevant `effectSet` in `stdlib/capabilities.agency` so agents
can grant it as a group (`raises <Network>`). Connectors go in `Network`:

```
export effectSet Network = <..., std::edgar, std::littlesis>
```

Only add the **semantic** effect (`std::littlesis`) — `std::http::fetchJSON` is already in
`Network`. A one-line compile-time assertion is a cheap regression guard (a `node` that
`raises <Network>` and calls the connector fails to compile if the effect isn't in the set).

---

## 8. Export a policy if it makes sense

If a connector has natural allow/deny defaults, consider exporting a ready-made `std::policy`
(`stdlib/policy.agency`) so users don't have to hand-write a handler. A policy is
declarative data keyed by effect with glob `match` on the payload, and — because the payload has an
`op` discriminant and the fetch carries `{ baseUrl, path, method }` — it can gate per-operation,
per-domain, or per-method (e.g. allow GETs, deny POSTs). An exported policy **must be `static`**
(globals can't be exported):

```
export static const POLICY: Policy = {
  "std::littlesis": [{ action: "approve" }],
  "std::http::fetchJSON": [
    { match: { baseUrl: "https://littlesis.org/api", method: "GET" }, action: "approve" },
    { action: "reject" }
  ]
}
```

---

## Gotchas (compile-clean ≠ runtime-correct)

These two **compile without error but break at runtime.** The only way to catch them is to run the
tests — so always run them, don't trust a clean build.

1. **Bind the interrupt-raising call to its own statement.** An interrupt-raising call nested in an
   argument or `match` scrutinee does not resume/gate at statement level: the `std::http::fetchJSON`
   interrupt silently fails to surface to outer handlers (and can fall through to a real network
   call). Write `const r = littlesisFetch(path); return finalize(r)` — **not**
   `return finalize(littlesisFetch(path))`. (The finance connectors' "bind the fetch to its own
   statement" comments encode this.)

2. **Do `Result`-consuming work before `return interrupt`.** A `match` or `.value` over a *typed*
   `Result` placed *after* a `return interrupt` statement fails to narrow (`.value is only available
   on a success Result`) — the `return` reads as a flow-terminal to the analyzer. Validate/unwrap
   before the interrupt (which is also better UX: fail fast on bad input without prompting, and it
   makes the failure path offline-testable). Bare `interrupt` / `const x = interrupt` don't have
   this problem, but `return interrupt` is the connector idiom.

---

## Testing

Connectors are tested with **agency-js** offline tests (no LLM, no network) plus one opt-in live
test. Copy `tests/agency-js/data-people-littlesis/`.

**Offline** (`agent.agency` node wrappers + `test.js` assertions + `fixture.json`):

- **Pure functions** — builders, parsers, finalizers (incl. error paths and null/empty input).
  Capture trimmed real API responses as `sample-*.json` and assert the reshaped output. *(Prefer
  a real captured body over a hand-authored one — a wrong field path otherwise ships green.)*
- **Interrupt gating** — assert (a) rejecting the semantic effect short-circuits before any fetch;
  (b) a plain caller sees only the semantic effect; (c) an outer handler that `propagate()`s the
  fetch surfaces `std::http::fetchJSON` with the exact `{ baseUrl, path, method }` — this proves the
  wiring *and* the built URL **offline, with no network**; (d) invalid input fails before the interrupt.
- **Capability** — a `node netCheck() raises <Network>` that calls the connector (compile-only).

**Live** (`*-live/`, gated on `AGENCY_LIVE_TESTS`): a real end-to-end call, `{ skipped: true }` by
default so CI never hits the network. Run it once manually to confirm the connector works against
the real API and your fixtures reflect reality.

---

## Docs

- Docstrings/`@module` are the source for the generated reference page — never hand-edit
  `docs/site/stdlib/**`. Run `make` (it runs `agency doc`).
- Add a nav entry in `docs/site/.vitepress/config.mts` under the `data` group.
- `make` after **any** `.agency` change (it rebuilds stdlib + `dist/` + docs).

---

## Checklist

- [ ] `static const` for base URL, allowed domains, lookup tables
- [ ] `effect std::<name> { op, ... }` with an `op` discriminant; no secrets in the payload
- [ ] Ergonomic types: strings/nulls/tagged-unions at the boundary, not raw API sentinels
- [ ] Flat typed records; total `parse*` (every field `?? default`)
- [ ] Pure `build*Path` / `parse*` / typed `*Finalize`; rate-limit hint in the error message
- [ ] Fetch gating chosen deliberately (Option A vs B); `allowedDomains` set; effect in `raises`
- [ ] Public functions: validate before the interrupt; fetch on its own statement
- [ ] `std::<name>` added to `Network` in `stdlib/capabilities.agency` (+ compile assertion)
- [ ] Optional: exported `static` `Policy`
- [ ] Offline agency-js tests (pure + gating + capability) and an opt-in live test — **run them**
- [ ] `make`; nav entry in `docs/site/.vitepress/config.mts`
