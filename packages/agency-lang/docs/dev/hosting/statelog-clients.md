# The statelog CLI client family

The CLI talks to statelog through seven sealed clients in `lib/cli/statelog/`,
one per route family: `uploadClient` (deploy), `projectClient` (project
reads), `accountClient` (account management), `serveClient` (invoking hosted
agents), `schedulesClient` (hosted schedules), `secretsClient` (hosted
environment secrets), and `evalUploadClient` (uploading eval run directories:
a trace's upload state, bulk sequenced events, annotation upsert; see
`docs/dev/evals/eval-tracking.md`). Each client alone knows its routes, wire
shapes, and failure **policy**; callers see typed values or the client's own
error type (`ProjectRequestError`, `AccountScopeError`, `SecretRequestError`,
`EvalUploadError`, …).

The family seals policy. `statelogRequest` seals transport separately, once.
A new client is exactly three things: route building, zod wire schemas, and a
failure mapper. It must not hand-roll fetch, body reading, or envelope
handling.

## The transport core: `statelogRequest`

`statelogRequest` (`lib/cli/statelog/statelogRequest.ts`) owns the pipeline
every client used to copy privately: fetch → `readJsonBody` → bare-`{error}`
extraction → `{ success, value | error }` envelope unwrap. It is
**result-returning** (`{ ok, value, status } | { ok, failure }`), formats no
user-facing messages, and builds no URLs. It is internal to this directory:
commands and recipes keep calling the family factories
(`createProjectClient`, `createSecretsClient`, …), never the core.

Classification order matters and is part of the contract (the families' tests
pin it): a rejected fetch is `unreachable`; then, under the default policy, a
non-2xx response is `http` — winning over `non-json` and envelope handling,
with a string `serverError` extracted only when the body parsed; then a parse
failure is `non-json`; then (unless `envelope: false`) a missing
`success: boolean` is `bad-envelope` and `success: false` is
`envelope-error`. Two option flags carry the two deliberate deviants:

- **`requireOk: false`** — `uploadClient` only. Upload has never inspected
  `response.ok`, so a non-2xx response with a success envelope still succeeds.
  Upload also passes `envelope: false` and unwraps the `{ success, value }`
  envelope itself in `readEndpointUrls`, so it can report a rejection with the
  server's own wording. Settled route semantics, pinned by characterization
  tests.
- **`contentType: "always"`** — `serveClient` only. Serve has always sent
  `Content-Type: application/json` on every call, bodyless `GET /list`
  included, and serializes `{}` for an undefined POST body. Serve also passes
  `envelope: false` for `/list`, which answers with bare JSON rather than the
  envelope. This is wire behavior too, and it is pinned too.

Programmer errors propagate as exceptions. An unserializable body and a
throwing sanitizer both land here. The failure union deliberately has no kind
for them.

## Failure mappers

Each family converts `StatelogFailure` to its own error with an **exhaustive
`switch (failure.kind)`** — no default arm that could silently absorb a
future kind. A mapper receives only the failure plus the smallest family
context it needs (`origin`, the request URL, `projectSlug`,
`unsupportedRouteMessage`); never a `Response`, headers, or a raw envelope.
The repeated-looking branches across mappers are NOT duplication to fold into
a configurable generic mapper: they carry deliberately different wording,
status handling, and 403/404 taxonomy per family (e.g. three different
meanings of 404: project-not-found, host-predates-this-route, and a plain
server error).

`secretsClient`'s mapper additionally owns redaction. It passes its per-verb
redactor to the core as `sanitizeDiagnostic`, and it also redacts every string
a failure can carry before a `SecretRequestError` exists: server errors,
diagnostics, and the unreachable message as a **whole**. Redacting that
message whole matters because a sensitive value can sit in the origin, not
only in the cause.

## Reading a response body: `readJsonBody`

The core reads bodies through `readJsonBody` (`lib/cli/statelog/jsonBody.ts`).
It reads text, parses it, and on failure reports the status **and the
request**, the **final URL** when a redirect moved the request (the classic
cause: an `http://` host whose https redirect turns an authenticated POST
into an anonymous GET of the sign-in page, served as HTML with HTTP 200), and
how the body starts. Its `sanitizeDiagnostic` option runs on the RAW text
before whitespace collapsing and truncation — diagnostic-only; protocol data
is always parsed from the original text.

## Rules for future changes

- Any bare `fetch(` or `response.json()` in `lib/cli/statelog/` outside
  `statelogRequest.ts`/`jsonBody.ts` is a review flag — that is the whole
  boundary.
- Test mocks for these clients stub `text()` (and `url`), never `json()`.
- Mappers stay exhaustive transcriptions; a new failure kind must fail
  compilation in every mapper, not vanish into a fallback.
