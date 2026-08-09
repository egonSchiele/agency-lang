# The statelog CLI client family

The CLI talks to statelog through five sealed clients in `lib/cli/statelog/`,
one per route family: `uploadClient` (deploy), `projectClient` (project
reads), `accountClient` (account management), `serveClient` (invoking hosted
agents), and `schedulesClient` (hosted schedules). Each client alone knows its
routes, wire shapes, and failure mapping; callers see typed values or the
client's own error type.

## Reading a response body: `readJsonBody`

All five clients read response bodies through `readJsonBody`
(`lib/cli/statelog/jsonBody.ts`) instead of calling `response.json()`
directly. The helper exists because "statelog returned a non-JSON response"
alone identifies neither the call site nor the cause — five clients used to
produce that identical string. `readJsonBody` reads the body as text, parses
it, and on failure reports:

- the status **and the request** (`… (HTTP 200) for POST http://…/upload`),
- the **final URL** when `response.url` shows fetch followed a redirect,
  plus the usual cause: an `http://` host URL, whose https redirect turns an
  authenticated POST into an anonymous GET of the sign-in page (served as
  HTML with HTTP 200),
- how the **body starts** (whitespace-collapsed, truncated).

Two rules for future changes:

- New statelog client code must go through `readJsonBody`, not
  `response.json()` — a bare `.json()` call reintroduces the anonymous
  "non-JSON response" error this helper exists to prevent.
- Test mocks for these clients must stub `text()` (and `url`), not `json()` —
  the clients never call `json()`.
