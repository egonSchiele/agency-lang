# MCP OAuth Support Design

## Overview

This spec adds OAuth 2.1 authentication support for HTTP-based MCP servers in Agency. It builds on the MCP support spec and provides a batteries-included OAuth flow that works out of the box for CLI usage and is customizable for TypeScript-import usage.

## Motivation

Many useful MCP servers (GitHub, Google Drive, Slack, etc.) require user-level OAuth authorization. Without OAuth support, Agency users are limited to:
- Stdio servers (local tools, no auth needed)
- HTTP servers with static API keys (manually obtained, no refresh)

This cuts off a large portion of the MCP ecosystem. The MCP spec defines OAuth 2.1 as the standard auth mechanism for HTTP servers, and most remote MCP servers will require it.

### Design goals

- **Zero-config for common cases.** Setting `"auth": "oauth"` in `agency.json` should just work for CLI usage — no TypeScript code required.
- **Batteries included.** Token storage, browser opening, callback server, PKCE, and refresh are all handled by the stdlib.
- **Customizable for non-CLI environments.** TypeScript users importing nodes can provide their own auth behavior via a lifecycle callback.
- **Secure by default.** Tokens stored with restrictive permissions, PKCE enforced, state parameter validated, tokens never serialized into checkpoints.

## Design

### User-facing configuration

MCP servers in `agency.json` gain an optional `auth` field:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://github-mcp.example.com/mcp",
      "auth": "oauth"
    },
    "weather": {
      "type": "http",
      "url": "https://weather-api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${WEATHER_API_KEY}"
      }
    }
  }
}
```

Three auth modes for HTTP servers:
- **No auth** (default) — no `auth` or `headers` field
- **Static headers** — `headers` object with env var interpolation (`${VAR_NAME}`)
- **OAuth** — `"auth": "oauth"`

Static headers and OAuth are mutually exclusive. Specifying both is a config validation error.

### Static headers (quick path)

The `headers` field is an object of string key-value pairs. Values support `${ENV_VAR}` interpolation (resolved at connection time from `process.env` and the Agency `.env` file). Headers are sent on every HTTP request to the MCP server.

```json
{
  "headers": {
    "Authorization": "Bearer ${GITHUB_TOKEN}",
    "X-Custom-Header": "some-value"
  }
}
```

If an env var is referenced but not set, the runtime throws at connection time with a clear error message.

### OAuth flow

When `"auth": "oauth"` is set, the runtime uses a built-in `OAuthClientProvider` that implements the full MCP OAuth 2.1 flow:

#### Step by step (CLI)

1. User runs `agency run myagent.agency`
2. Agent calls `mcp("github")` → `McpConnection` connects to the server
3. If no valid stored token exists, the MCP SDK triggers the OAuth flow
4. The stdlib provider:
   a. Starts a temporary localhost HTTP server on an available port
   b. Opens the user's default browser to the authorization URL
   c. Prints a message: `Waiting for authorization for "github"... (press Ctrl+C to cancel)`
   d. Waits for the callback (with a timeout)
5. User authorizes in the browser → redirected to `http://localhost:PORT/oauth/callback`
6. Callback server receives the authorization code, validates the `state` parameter, shuts down
7. MCP SDK exchanges code for tokens (with PKCE verifier)
8. Stdlib provider stores tokens to disk
9. `mcp("github")` returns tools — execution continues

#### Subsequent runs

On subsequent runs, the stored token is loaded from disk. If expired, the refresh token is used automatically (handled by the MCP SDK). The user sees no browser popup unless the refresh token has also expired or been revoked.

### Token storage

Tokens are stored at `~/.agency/tokens/<server-name>.json`:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresAt": 1713600000,
  "scope": "repo read:user"
}
```

File permissions are set to `0600` (user-read-write only) on creation. The directory `~/.agency/tokens/` is created with `0700` permissions.

PKCE code verifiers are stored temporarily in `~/.agency/tokens/<server-name>.verifier` during the auth flow and deleted after the token exchange completes.

### Token refresh and re-authentication

The MCP SDK handles token refresh transparently. However, there are edge cases:

**Refresh succeeds:** No user interaction needed. New tokens are stored.

**Refresh fails (token revoked or expired):** The full OAuth flow is triggered again (browser opens). This is signaled to the user:
```
Token for "github" expired. Re-authorizing... (opening browser)
```

**Step-up authorization (403 insufficient_scope):** If the server returns a 403 with `insufficient_scope`, the runtime re-triggers the OAuth flow with the expanded scope. The user sees:
```
"github" requires additional permissions. Authorizing... (opening browser)
```

### Concurrency handling

**Multiple `fork` threads hitting the same server:**
`McpManager` already caches connections per server name. The OAuth flow is triggered during `McpConnection.connect()`, which is called once per server (subsequent calls reuse the connection). If two threads race to connect, the underlying connection promise is shared — only one OAuth flow fires.

Concretely: `McpManager.getTools(serverName)` checks if a connection (or connection attempt) already exists. If it does, it awaits the existing promise rather than starting a new connection.

**Multiple agent runs on the same machine:**
Token files are shared on disk. If one run stores a token, the next run picks it up. File locking is not needed because writes are atomic (write to temp file, rename).

**Refresh token rotation:**
Some servers rotate refresh tokens on each use. To prevent race conditions where two concurrent refreshes invalidate each other, the `saveTokens()` implementation uses atomic file writes (write to `<name>.json.tmp`, then `rename()`). The MCP SDK serializes refresh requests per-connection, so concurrent refreshes on the same connection won't happen. Across separate agent runs, the last writer wins — acceptable since the latest refresh token is always the valid one.

### TypeScript-import usage

When a node is imported and called from TypeScript, the default behavior is the same (open browser, callback server). This works fine when the TypeScript code is running on a developer's machine.

For server/headless environments, a lifecycle callback overrides the default:

```typescript
import { main } from "./myagent.js";

const result = await main("query", {
  callbacks: {
    onOAuthRequired: async ({ serverName, authUrl, complete }) => {
      // Option 1: Send the URL to the user (web app, Slack, etc.)
      await sendToUser(`Please authorize: ${authUrl}`);
      // The callback server still handles the redirect — just don't open a browser
      // `complete` is a promise that resolves when auth finishes
      await complete;
    }
  }
});
```

The `onOAuthRequired` callback receives:
- `serverName` — which MCP server needs auth
- `authUrl` — the full authorization URL to present to the user
- `complete` — a promise that resolves when the auth flow finishes (callback received)
- `cancel` — a function to abort the auth flow

If `onOAuthRequired` is provided, the runtime does NOT open a browser — it calls the hook instead. The localhost callback server still runs to receive the redirect.

If the environment truly can't receive a localhost redirect (e.g., a remote server with no port access), the user must pre-authorize. This can be done by:
1. Running `agency auth github` from a machine with a browser (stores token to disk)
2. Copying `~/.agency/tokens/github.json` to the server
3. Or providing a token directly via the `headers` config approach

### CLI auth command

A new CLI command for pre-authorizing or managing tokens:

```bash
# Trigger OAuth flow for a server (stores token)
agency auth <server-name>

# List stored tokens and their status
agency auth --list

# Remove a stored token
agency auth --revoke <server-name>
```

This is useful for:
- Pre-authorizing before running an agent
- CI/CD setup (auth on a dev machine, copy token to CI)
- Debugging token issues

### Cancellation and cleanup

**User cancels during OAuth (Ctrl+C):**
- The callback server is shut down
- No tokens are stored
- `mcp()` returns a `failure("OAuth flow cancelled for \"github\"")`
- The agent can handle this via `catch`:
  ```
  const tools = mcp("github") catch []
  ```

**Agent cancelled (`AgencyCancelledError`) during OAuth:**
- Same as above — callback server shut down, failure propagated

**Timeout:**
The OAuth flow has a configurable timeout (default: 5 minutes). If the user doesn't complete auth in time:
- Callback server shuts down
- `mcp()` returns a `failure("OAuth flow timed out for \"github\"")`
- A message is printed: `Authorization timed out for "github".`

The timeout is configurable per-server:
```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://...",
      "auth": "oauth",
      "authTimeout": 120000
    }
  }
}
```

### Serialization and checkpoints

**Tokens are NEVER serialized into checkpoints.** This is critical for security — checkpoints may be stored, shared, or logged.

On restore after a checkpoint:
1. MCP tool objects deserialize as plain data (they contain `serverName`, `name`, etc. — no tokens)
2. When the tool is actually called post-restore, `McpManager` reconnects to the server
3. The OAuth provider loads tokens from disk (not from the checkpoint)
4. If tokens are still valid, the call proceeds. If not, re-auth is triggered.

This matches the existing design in the MCP support spec where `McpManager` reconnects lazily after restore.

### Error handling

| Scenario | Behavior |
|----------|----------|
| `auth: "oauth"` on a stdio server | Config validation error (thrown at load time) |
| Both `auth` and `headers` specified | Config validation error |
| Server doesn't support OAuth (no 401) | Connection proceeds without auth (server may not need it) |
| Browser fails to open (headless, no display) | Falls back to printing the URL: `Please open this URL to authorize: <url>` |
| Callback port in use | Try up to 10 random ports in the 49152-65535 range. If all fail, return failure. |
| Network error during token exchange | `mcp()` returns failure with error details |
| Invalid state parameter on callback | Reject the callback, return failure (possible CSRF) |
| User denies authorization | `mcp()` returns failure |

### Interaction with interrupts

OAuth flows are NOT interrupt-based. They are handled entirely within the `mcp()` call. The reasoning:
- OAuth is infrastructure, not a user-facing decision about agent behavior
- Interrupts are for "should the agent do this?" — OAuth is "the agent needs credentials to function"
- Making OAuth an interrupt would complicate restore semantics (you'd serialize mid-auth state)

However, if the user wraps `mcp()` in a handler, a failure from OAuth (timeout, cancelled, denied) is just a regular `failure` Result that they can handle:

```ts
const tools = mcp("github") catch []
if (len(tools) == 0) {
  print("Couldn't connect to GitHub. Continuing without GitHub tools.")
}
```

### Config schema additions

```typescript
const McpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  auth: z.literal("oauth").optional(),
  authTimeout: z.number().optional(), // milliseconds, default 300000
  headers: z.record(z.string()).optional(),
}).refine(
  (data) => !(data.auth && data.headers),
  { message: "Cannot specify both 'auth' and 'headers'" }
);
```

## Implementation

### New files

- `lib/runtime/mcp/oauthProvider.ts` — The `OAuthClientProvider` implementation (token storage, browser opening, callback server)
- `lib/runtime/mcp/callbackServer.ts` — Temporary localhost HTTP server for receiving OAuth redirects
- `lib/runtime/mcp/tokenStore.ts` — Read/write/delete token files with atomic writes and correct permissions
- `lib/cli/auth.ts` — CLI command for `agency auth`
- `tests/mcp/oauth.test.ts` — Unit tests for the OAuth provider (mocked browser/callback)
- `tests/mcp/tokenStore.test.ts` — Token storage tests
- `tests/mcp/callbackServer.test.ts` — Callback server tests

### Modified files

- `lib/runtime/mcp/mcpConnection.ts` — Pass auth provider (or headers) to the MCP SDK client based on config
- `lib/runtime/mcp/types.ts` — Add auth-related config types
- `lib/config.ts` — Extend `McpHttpServerSchema` with `auth`, `authTimeout`, `headers` fields and the mutual exclusion validation
- `lib/runtime/state/context.ts` — Thread `onOAuthRequired` callback from lifecycle hooks to `McpManager`
- `scripts/agency.ts` — Register the `agency auth` CLI command

### Dependencies

**New:**
- `open` — for opening the browser (small, well-maintained, already commonly used)

**Already present (from MCP support spec):**
- `@modelcontextprotocol/sdk` — includes `OAuthClientProvider` interface and OAuth utilities

### Testing approach

OAuth is hard to test end-to-end. The strategy:

1. **Unit test `tokenStore.ts`** — file read/write, permissions, atomic writes, env var interpolation for headers
2. **Unit test `callbackServer.ts`** — starts server, receives callback with code + state, validates state, rejects bad state, shuts down on timeout
3. **Unit test `oauthProvider.ts`** — mock the callback server and browser opener, verify the provider calls them correctly, verify tokens are stored/loaded
4. **Integration test with mock OAuth server** — a test HTTP server that implements the MCP OAuth discovery flow (returns 401, serves metadata, issues tokens). Verify the full flow works without a real browser (by calling the callback URL directly in the test).

The integration test does NOT open a real browser — it simulates the callback by making an HTTP request to the callback server directly.

## Out of scope

- Custom OAuth providers defined in Agency code (always uses the built-in provider; TypeScript users can override via callback)
- OAuth for stdio servers (not applicable per MCP spec)
- Token encryption at rest (file permissions are the security boundary; users who need more can use OS keychain integrations)
- Multi-user token management (e.g., a web app with many users — this requires a custom `onOAuthRequired` implementation)
- Dynamic client registration UI (the MCP SDK handles this via Client ID Metadata Documents)
- Refresh token storage across machines (users must manually copy `~/.agency/tokens/` or use `agency auth` on each machine)
