# MCP Login Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency agent` starts without ever starting an MCP login, and the user logs in to, logs out of, and reconnects MCP servers from a `/mcp` menu.

**Architecture:** The `@agency-lang/mcp` package gets a second way to connect that fails with "needs login" instead of opening a browser, a login split into a start step and a finish step, and one record per server that holds its status and tools. `std::mcp` wraps those in eight Agency functions. The agent reads server state from `std::mcp` on every turn and keeps no copy of it in Agency globals.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` 1.29.0, vitest, Agency (`.agency` files compiled by this repo).

**Spec:** `docs/superpowers/specs/2026-11-16-mcp-login-menu.md` in this worktree. Read it in full before you start. This plan gives the names, files, and tests. The spec gives the reasons and the exact text the user sees.

All paths in this plan are relative to the worktree root, `/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/mcp-login-menu`, unless they start with `/`.

---

## Background you need

### The two packages

- `packages/mcp` is `@agency-lang/mcp`, version 0.0.5 today. It is a separate npm package. agency-lang does not depend on it.
- `packages/agency-lang` reaches it through one file, `lib/stdlib/mcpBridge.mjs`, which loads the package with `import()`. The types for the bridge are in `lib/stdlib/mcpBridge.d.mts`. The stdlib TypeScript is `lib/stdlib/mcp.ts`, and the Agency module is `stdlib/mcp.agency`.
- `docs/dev/stdlib/mcp-package-loading.md` explains how the package is found. Tests point the environment variable `AGENCY_MCP_PATH` at a file to load in its place.

### How the package connects today

Read these five files before you change them. Together they are about 650 lines.

- `packages/mcp/src/mcp.ts`: the exports `mcp()` and `mcpRaw()`, and `getManager`, which builds one `McpManager` per process on the first call.
- `packages/mcp/src/mcpManager.ts`: holds the config, the connections, and a tool cache. `getTools` connects. `callTool` builds a connection when it has none (lines 96 to 104).
- `packages/mcp/src/oauthConnector.ts`: `connect()` starts the callback page, connects, and on an `UnauthorizedError` waits for the browser and connects again.
- `packages/mcp/src/oauthProvider.ts`: `AgencyOAuthProvider`, the object the SDK asks for tokens, the redirect URL, and the `state` value. `redirectUrl` and `state()` throw unless `prepare()` ran.
- `packages/mcp/src/callbackServer.ts`: the local web page on port 19876 that the browser returns to. It creates its own `state` (line 27), starts its timer in `start()` (line 85), and `stop()` never settles the promise that `waitForCode()` returns.

### What the SDK does, and where

The SDK file is `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0*/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js`. You will need to read `auth()` and `authInternal()` (lines 146 to 310). The parts this plan depends on:

- Line 260 reads `provider.redirectUrl` on every call, before any refresh.
- Lines 273 to 286 refresh with the saved refresh token. There is no lock, so two requests can refresh at once.
- Lines 287 to 296: a refresh that fails with a server error or a network error does not throw. The code moves on to a new login.
- Line 298 calls `provider.state()`, and the lines after it call `provider.saveCodeVerifier` and `provider.redirectToAuthorization`.
- Lines 152 to 159: on `InvalidGrantError` the SDK calls `provider.invalidateCredentials?.('tokens')` and runs `authInternal` once more. On `InvalidClientError` it passes `'all'`.

After `redirectToAuthorization` returns, the transport throws `UnauthorizedError` (`client/streamableHttp.js`). An error thrown inside `redirectToAuthorization` comes out of `client.connect()` or `client.callTool()`.

### How the agent uses MCP today

- `lib/agents/agency-agent/agent.agency:150` calls `maybeLoadMcp(loadSettings())` at startup, before the policy handler exists.
- `lib/agents/agency-agent/lib/mcp.agency` holds two globals, `mcpTools` and `mcpServerStatus`, and the `/mcp` command, which prints a status list.
- `lib/agents/agency-agent/lib/cliTools.agency:76` calls `getMcpTools()` on every turn.
- `docs/dev/agents/agent-sessions.md`, "How a resume works", explains why state must not live in an Agency global: a resume replaces every `let` global with the saved one.

### Rules of this repo that apply here

Read `packages/agency-lang/CLAUDE.md` and `packages/agency-lang/docs/dev/contributing/anti-patterns.md`.

---

## Global Constraints

- The new package version is `0.0.6`. `MIN_MCP_VERSION` in agency-lang is `"0.0.6"`.
- The callback page's default port stays `19876`. The redirect URL is `http://127.0.0.1:<port>/oauth/callback`.
- `authTimeout` defaults to 5 minutes (300000 ms) and is counted from the call to `finishLogin`.
- User-facing text is copied from the spec exactly. The strings are listed in the task that prints each one.
- `mcp()`, `mcpRaw()`, `loadMcpTools`, and `loadMcpToolsWithStatus` keep their 0.0.5 behavior for a server no new export has touched.
- No dynamic `import()` in TypeScript. The bridge `.mjs` is the one exception, and it already exists.
- Use objects, not `Map`. Use arrays, not `Set`. Use `type`, not `interface`.
- Add no TypeScript module-level state. New state goes on the `McpManager` instance.
- Add no code to support symbolic links.
- Change files with the Edit and Write tools only. Do not edit files with `sed`, a heredoc, or a script.
- Do not edit anything under `docs/site/`. The stdlib reference pages there are regenerated by `make`. The hand-written guide page `docs/site/guide/mcp.md` needs the owner's go-ahead, which the spec lists as an open question.
- Do not edit `CHANGELOG.md`.
- Never amend a commit, never force push, never commit to `main`. Check `git branch --show-current` before each commit. It must print `adit/mcp-login-menu` in tasks 1 to 6 and `adit/mcp-login-menu-agent` in tasks 7 to 12.
- Write each commit message to a file in the scratchpad and pass it with `git commit -F <file>`. A message with an apostrophe on the command line fails.
- Never run `git stash` in this worktree. The stash list is shared with every other worktree.
- Tests in `packages/agency-lang` delete temporary folders with `safeDeleteDirectoryWithin` from `lib/utils.ts`, never with a hand-written `rm`. Tests in `packages/mcp` cannot import that helper, because agency-lang does not export it. They follow the pattern already in `packages/mcp/tests/oauthConnector.test.ts`: the folder comes from `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, and `fs.rmSync` is given that same variable and nothing else. Never pass `rmSync` a path built any other way.
- No test may approve `std::openUrl`. An approval runs `open` and opens a real browser.

## How to test

Builds and test runs are slow here. Do each of these once per PR, after all of that PR's tasks are written, and save the output to a file so that a failure does not need a second run.

**Setup, once.** The worktree has no `node_modules` yet.

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/mcp-login-menu
pnpm install
cd packages/agency-lang && make
```

**PR 1, the package.** Run from `packages/mcp`:

```bash
pnpm run build > "$SCRATCH/mcp-build.log" 2>&1; echo "exit $?"
pnpm exec vitest run > "$SCRATCH/mcp-test.log" 2>&1; echo "exit $?"
```

`$SCRATCH` is your scratchpad directory. Both commands must print `exit 0`.

**PR 2, agency-lang.** Run from `packages/agency-lang`. `make` is needed because stdlib files change.

```bash
make > "$SCRATCH/al-make.log" 2>&1; echo "exit $?"
pnpm run typecheck > "$SCRATCH/al-typecheck.log" 2>&1; echo "exit $?"
pnpm exec vitest run lib/stdlib/mcp.test.ts lib/stdlib/mcpVersion.test.ts lib/stdlib/mcpBridge.contract.test.ts > "$SCRATCH/al-vitest.log" 2>&1; echo "exit $?"
HOME="$SCRATCH/home" pnpm run agency test lib/agents/agency-agent/tests/mcpMenu.test.json --check-capabilities > "$SCRATCH/al-agent.log" 2>&1; echo "exit $?"
HOME="$SCRATCH/home" pnpm run agency test lib/agents/agency-agent/tests/toolPresentations.test.json --check-capabilities >> "$SCRATCH/al-agent.log" 2>&1; echo "exit $?"
pnpm run agency test tests/agency/mcp-logout.test.json --check-capabilities > "$SCRATCH/al-logout.log" 2>&1; echo "exit $?"
pnpm run lint:structure > "$SCRATCH/al-lint.log" 2>&1; echo "exit $?"
```

Create `$SCRATCH/home` first. The agent tests read and write under the home folder, and they must not touch the real one.

Format only the files you changed: `pnpm exec prettier --write <file> <file>`. Do not run `pnpm run fmt:ts`, and do not run `agency fmt` on an existing `.agency` file. Run `agency fmt -i` only on `.agency` files this plan creates.

Do not run the whole Agency test suite. CI runs it on the PR.

## Review Focus

These are the cases most likely to hurt a user. Each has a test in the task named.

1. Two tool calls at the moment a login expires, on a server that gives out a new refresh token each time. Both must succeed and the saved login must survive. Task 4, test "two calls at expiry".
2. A login the user abandons, for example by pressing Escape at the approval question. The next login, to any server, must work. Task 5, test "a second login cancels the first".
3. A connect with a saved login must not end the process with an unhandled rejection. Task 2, test "stop with nobody waiting".
4. `mcpRaw()` on a server with no saved login must still log in as it does in 0.0.5. Task 4, test "ask first still logs in".
5. A tool call after a log out, or after a login expired, must fail with "needs a new login" and must not open a browser. Task 5, tests "call after logout" and "expiry on a live connection".

---

# PR 1: `@agency-lang/mcp` 0.0.6

Branch `adit/mcp-login-menu`. Tasks 1 to 6. Open the PR against `main` and stop. The owner merges and publishes.

The spec, this plan, and the three review files are untracked in the worktree. Task 1's commit adds all five, so they ship with PR 1:

- `packages/agency-lang/docs/superpowers/specs/2026-11-16-mcp-login-menu.md`
- `packages/agency-lang/docs/superpowers/specs/2026-11-16-mcp-login-menu-review.md`
- `packages/agency-lang/docs/superpowers/specs/2026-11-16-mcp-login-menu-review-2.md`
- `packages/agency-lang/docs/superpowers/plans/2026-11-16-mcp-login-menu.md`
- `packages/agency-lang/docs/superpowers/plans/2026-11-16-mcp-login-menu-review.md`

Add files by name. Do not run `git add -A`.

### Task 1: A fake OAuth MCP server for tests

The package has no way to test a login today. `tests/oauthConnector.test.ts` has two tests, and neither reaches a server. Every later task needs this helper.

**Files:**
- Create: `packages/mcp/tests/fakeOAuthServer.ts`
- Create: `packages/mcp/tests/fakeOAuthServer.test.ts`

**Interfaces:**
- Produces:

```ts
export type FakeOAuthServer = {
  /** The MCP endpoint, for a server config's `url`. */
  mcpUrl: string;
  /** Make every access token given out so far stop working. */
  expireAccessTokens: () => void;
  /** From now on, answer every refresh with `invalid_grant`. */
  rejectRefreshTokens: () => void;
  /** How many refresh requests the token endpoint has answered. */
  refreshCount: () => number;
  close: () => Promise<void>;
};

export type FakeOAuthServerOptions = {
  /** Give out a new refresh token on each refresh and refuse the old one. Default false. */
  rotateRefreshTokens?: boolean;
  /** Hold each refresh response this long, so two refreshes overlap. Default 0. */
  refreshDelayMs?: number;
};

export function startFakeOAuthServer(options?: FakeOAuthServerOptions): Promise<FakeOAuthServer>;

/** A port nothing is listening on. Open a server on port 0, read its port, close it. */
export function freePort(): Promise<number>;

/** Do what the browser does at the end of a login: read `redirect_uri` and `state`
 *  from the login URL and request `<redirect_uri>?code=<code>&state=<state>`. */
export function completeLogin(authUrl: string, code?: string): Promise<Response>;

/** A config for the fake server, as agency.json would hold it. */
export function oauthConfig(server: FakeOAuthServer, authTimeout?: number): McpHttpServerConfig;
```

The server is one `http.createServer` on `127.0.0.1` with a system-chosen port. It serves:

| Path | Behavior |
|---|---|
| `GET /.well-known/oauth-protected-resource` and the same path with `/mcp` appended | The resource metadata, naming this server as its own authorization server. |
| `GET /.well-known/oauth-authorization-server` | Metadata with `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `response_types_supported: ["code"]`, and `code_challenge_methods_supported: ["S256"]`. |
| `POST /register` | Returns the posted client metadata with a new `client_id`. |
| `POST /token`, `grant_type=authorization_code` | Accepts any code. Returns an access token and a refresh token. |
| `POST /token`, `grant_type=refresh_token` | Returns a new access token for a refresh token it knows. Returns status 400 with `{"error":"invalid_grant"}` for one it does not know, or for any when `rejectRefreshTokens()` was called. With `rotateRefreshTokens`, it also returns a new refresh token and forgets the old one. |
| `POST /mcp` | Status 401 with a `WWW-Authenticate: Bearer` header unless the request carries a current access token. Otherwise it serves MCP. |

Serve MCP with the SDK's own server classes, `McpServer` and `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`), with one tool named `add` that takes two numbers and returns their sum as text. `packages/mcp/tests/__tests__/testServer.mjs` shows the tool definition for the stdio case.

Read `discoverOAuthProtectedResourceMetadata` and `discoverAuthorizationServerMetadata` in the SDK's `client/auth.js` to see the exact paths and fields the client asks for. Serve what it asks for and no more.

- [ ] **Step 1: Write the helper's own tests** in `fakeOAuthServer.test.ts`:

```ts
it("refuses MCP without a token", async () => {
  const server = await startFakeOAuthServer();
  const res = await fetch(server.mcpUrl, { method: "POST", body: "{}" });
  expect(res.status).toBe(401);
  await server.close();
});

it("freePort returns a port a server can bind", async () => {
  const port = await freePort();
  expect(port).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Write `fakeOAuthServer.ts`** to the interface above.
- [ ] **Step 3: Commit** with the message `Add a fake OAuth MCP server for the mcp package tests`.

### Task 2: The callback page takes its `state`, starts its timer on the wait, and rejects on stop

**Files:**
- Modify: `packages/mcp/src/callbackServer.ts`
- Modify: `packages/mcp/tests/callbackServer.test.ts`

**Interfaces:**
- Produces:

```ts
export const DEFAULT_CALLBACK_PORT = 19876;

export type CallbackServerOptions = {
  port?: number;        // default DEFAULT_CALLBACK_PORT
  timeoutMs?: number;   // default 300000
  state: string;        // required: the value the provider put in the login URL
};

export function callbackUrlFor(port?: number): string; // "http://127.0.0.1:<port>/oauth/callback"

class CallbackServer {
  start(): Promise<void>;          // listens; starts no timer
  waitForCode(): Promise<string>;  // the first call starts the timer
  stop(): Promise<void>;           // rejects a pending wait with Error(LOGIN_CANCELLED)
}

export const LOGIN_CANCELLED = "login cancelled";
```

Three behavior changes:

1. The constructor no longer creates a `state`. The request handler compares against `options.state`.
2. `start()` no longer starts the timer. The first `waitForCode()` call does. The timeout error stays `"OAuth callback timed out"`.
3. The constructor attaches an empty `catch` handler to the code promise, so a rejection nobody waits on is dropped. `stop()` rejects the promise with `LOGIN_CANCELLED` when no code has arrived. Rejecting a promise that is already settled does nothing, so `stop()` needs no check.

The empty handler is the one place in this plan where an error is dropped with no log. It is correct here: a caller that does wait on `waitForCode()` still gets the rejection, and the handler only covers the case where nobody is waiting. Put that in a comment on the line.

The message is the text the user sees when they cancel a login, so no later layer has to translate it.

The existing tests pass `{ port: 0 }` and read the port back. Change them to `{ port: await freePort(), state: "s1" }`.

- [ ] **Step 1: Add these tests:**

```ts
it("stop rejects a pending waitForCode", async () => {
  const server = new CallbackServer({ port: await freePort(), state: "s1" });
  await server.start();
  const wait = server.waitForCode();
  await server.stop();
  await expect(wait).rejects.toThrow("login cancelled");
});

it("stop with nobody waiting raises no unhandled rejection", async () => {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  const server = new CallbackServer({ port: await freePort(), state: "s1" });
  await server.start();
  await server.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off("unhandledRejection", onRejection);
  expect(seen).toEqual([]);
});

it("does not time out before waitForCode is called", async () => {
  const server = new CallbackServer({ port: await freePort(), state: "s1", timeoutMs: 30 });
  await server.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const wait = server.waitForCode();           // the timer starts here
  await expect(wait).rejects.toThrow("OAuth callback timed out");
});

it("refuses a request with another state", async () => {
  const port = await freePort();
  const server = new CallbackServer({ port, state: "s1" });
  await server.start();
  const res = await fetch(`${callbackUrlFor(port)}?code=c&state=other`);
  expect(res.status).toBe(403);
  await server.stop();
});
```

- [ ] **Step 2: Change `callbackServer.ts`** to the interface above.
- [ ] **Step 3: Commit** with the message `Callback page: take the state value, start the timer on the wait, reject on stop`.

### Task 3: Delete a saved login without the registration

**Files:**
- Modify: `packages/mcp/src/tokenStore.ts`
- Modify: `packages/mcp/tests/tokenStore.test.ts`

**Interfaces:**
- Produces: `TokenStore.deleteLogin(serverName: string): Promise<void>`. It deletes `<server>.json` and nothing else.

`deleteTokens` (line 72) already deletes the login, the code verifier, and the registration. Leave it as it is. `npx @agency-lang/mcp auth --revoke` uses it.

- [ ] **Step 1: Add a test:** save tokens and client info for `"linear"`, call `deleteLogin("linear")`, and expect `loadTokens` to return `undefined` and `loadClientInfo` to return the saved info.
- [ ] **Step 2: Add `deleteLogin`.**
- [ ] **Step 3: Commit** with the message `TokenStore: delete a saved login and keep the registration`.

### Task 4: The provider and the connector: login modes, a split login, and `invalidateCredentials`

This is the largest task. The two files change together, so they are one task.

**Files:**
- Create: `packages/mcp/src/needsLogin.ts`
- Modify: `packages/mcp/src/oauthProvider.ts`
- Modify: `packages/mcp/src/oauthConnector.ts`
- Modify: `packages/mcp/tests/oauthProvider.test.ts`
- Modify: `packages/mcp/tests/oauthConnector.test.ts`

**Interfaces:**
- Consumes: `CallbackServer`, `callbackUrlFor`, `DEFAULT_CALLBACK_PORT` (Task 2). `TokenStore.deleteLogin` (Task 3). The fake server (Task 1).
- Produces:

```ts
// needsLogin.ts
export class NeedsLoginError extends Error {
  serverName: string;
  constructor(serverName: string); // message: `MCP server "<serverName>" needs a new login.`
}

// oauthProvider.ts
export type LoginMode = "askFirst" | "never";
export type OAuthProviderOptions = {
  onOAuthRequired?: (data: OAuthRequiredData) => void | Promise<void>;
  timeoutMs?: number;
  clientId?: string;
  clientSecret?: string;
  port?: number;
  loginMode?: LoginMode; // default "askFirst"
};

// oauthConnector.ts
class OAuthConnector {
  connect(): Promise<OAuthConnectResult>;      // "never" mode: rejects with NeedsLoginError when a login is needed
  startLogin(): Promise<string>;               // resolves with the login page URL
  finishLogin(): Promise<OAuthConnectResult>;  // waits for the browser, saves the login, connects
  cancelLogin(): Promise<void>;                // stops the callback page; a waiting finishLogin rejects
}
```

**The provider.** Remove `prepare()`. The provider has three situations, and `redirectToAuthorization` does a different thing in each:

| Situation | What `redirectToAuthorization(url)` does |
|---|---|
| A login is being started (`startLogin` set a flag) | Starts the callback page with the last `state` value, keeps `url` for `startLogin` to return, and returns. |
| Mode `"never"`, no login being started | Throws `NeedsLoginError`. Starts nothing. |
| Mode `"askFirst"`, no login being started | Starts the callback page with the last `state` value, then does what 0.0.5 does: calls `onOAuthRequired`, or opens the browser. |

The other provider changes:

- `redirectUrl` returns `callbackUrlFor(options.port)`. It never throws.
- `state()` creates a new random value on each call (`randomBytes(32).toString("hex")`), remembers it, and returns it.
- `tokens()` returns `undefined` while a login is being started. Otherwise it loads the saved login.
- `noteRejectedRefreshToken(token: string): void` records the refresh token the server last refused. The connector calls it, as described below.
- `invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery")`:
  - `"tokens"`: read the saved login again. If its `refresh_token` differs from the recorded rejected one, do nothing. Otherwise call `store.deleteLogin`.
  - `"all"`: call `store.deleteTokens`, which also deletes the registration.
  - Any other scope: do nothing.
- `cleanup()` stops the callback page if one is running and deletes the code verifier. It no longer clears the redirect URL.

Only the "ask first" branch sets up the `complete` promise and calls `waitForCode()` for it. Today that wiring runs before the branch (`oauthProvider.ts:162-167`). With Task 2 the first `waitForCode()` starts the timer, so leaving the wiring where it is would start the timer at `startLogin`.

**Which refresh token was rejected.** The provider cannot learn this from the SDK. `invalidateCredentials` gets no token, and `tokens()` is no guide, because the transport also calls it to build every request's `Authorization` header (`client/streamableHttp.js:58-61`). After the first of two calls has refreshed, the last token `tokens()` returned is the new one.

The SDK does send every token request through the `fetch` given in the transport's options (`streamableHttp.js:31-32` and `:322-327`). So `createTransport()` in the connector passes a `fetch` that calls the real `fetch` and then looks at the request and the response. When the request body has `grant_type=refresh_token` and the response is status 400 with `"error": "invalid_grant"` in its JSON body, it calls `provider.noteRejectedRefreshToken` with the request's `refresh_token`. It reads the body from a clone of the response and returns the response unchanged. Put this in a function of its own in `oauthConnector.ts`:

```ts
/** A fetch that reports each refresh token the server refuses. */
function watchingRefreshes(onRejected: (refreshToken: string) => void): typeof fetch;
```

**The connector.** `connect()` no longer calls `prepare()`. The rest of `connect()` stays, so "ask first" still waits for the browser after an `UnauthorizedError`. A `NeedsLoginError` from `client.connect()` passes through. If the SDK wraps it, one exported function in `needsLogin.ts` unwraps it, `asNeedsLogin(error: unknown): NeedsLoginError | null`, so that callers can test the result. `client.callTool()` takes a different path through the SDK (`Protocol.request` and the transport's `send`), and `McpManager.callTool` in Task 5 uses the same function. The tests in step 1 and in Task 5 tell you whether either path wraps.

`startLogin()` sets the provider's flag, builds a client and a transport, and calls `client.connect()`. It expects an `UnauthorizedError`, keeps the transport for `finishLogin`, and returns the URL the provider kept. If the connect succeeds, the server never asked for a login: close the client, clear the flag, and throw `Error('MCP server "<name>" did not ask for a login')`.

`finishLogin()` is the second half of today's `connect()`: wait for the code, call `transport.finishAuth(code)`, clear the flag, close the first client, connect with a new client and transport, and call `cleanup()` in a `finally`.

`cancelLogin()` clears the flag and calls `cleanup()`.

- [ ] **Step 1: Write the tests.** Each one starts a fake server, uses a temporary folder for the `TokenStore`, and passes `port: await freePort()`.

```ts
it("never mode: connect rejects with NeedsLoginError and starts no page", async () => {
  const connector = new OAuthConnector("linear", server.mcpUrl, store, { port, loginMode: "never" });
  await expect(connector.connect()).rejects.toBeInstanceOf(NeedsLoginError);
  // nothing listens on the callback port
  await expect(fetch(callbackUrlFor(port))).rejects.toThrow();
});

it("two never-mode connects at once both need a login", async () => {
  // same port for both, as in production
  const a = new OAuthConnector("a", server.mcpUrl, store, { port, loginMode: "never" });
  const b = new OAuthConnector("b", server.mcpUrl, store, { port, loginMode: "never" });
  const results = await Promise.allSettled([a.connect(), b.connect()]);
  expect(results.map((r) => r.status === "rejected" && r.reason instanceof NeedsLoginError)).toEqual([true, true]);
});

it("startLogin then finishLogin connects and saves the login", async () => {
  const connector = new OAuthConnector("linear", server.mcpUrl, store, { port, loginMode: "never" });
  const url = await connector.startLogin();
  const finished = connector.finishLogin();
  await completeLogin(url);
  const { client } = await finished;
  expect((await client.listTools()).tools[0].name).toBe("add");
  expect(await store.loadTokens("linear")).toBeDefined();
  await client.close();
});

it("a saved login connects with no page and no unhandled rejection", async () => { /* log in once, build a new connector, connect, assert as in Task 2's rejection test */ });

it("startLogin ignores a working saved login, and cancel keeps it", async () => {
  // log in once; then:
  const before = await store.loadTokens("linear");
  const url = await connector.startLogin();
  expect(url).toContain("code_challenge");
  await connector.cancelLogin();
  expect(await store.loadTokens("linear")).toEqual(before);
});

it("cancelLogin makes a waiting finishLogin reject, and the port is free again", async () => {
  await connector.startLogin();
  const finished = connector.finishLogin();
  await connector.cancelLogin();
  await expect(finished).rejects.toThrow("login cancelled");
  await connector.startLogin();   // binds the same port
  await connector.cancelLogin();
});

it("two logins in a row use different state values", async () => {
  const first = new URL(await connector.startLogin()).searchParams.get("state");
  await connector.cancelLogin();
  const second = new URL(await connector.startLogin()).searchParams.get("state");
  await connector.cancelLogin();
  expect(second).not.toBe(first);
});

it("finishLogin counts its timeout from its own call", async () => {
  const connector = new OAuthConnector("linear", server.mcpUrl, store, { port, loginMode: "never", timeoutMs: 60 });
  await connector.startLogin();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const started = Date.now();
  await expect(connector.finishLogin()).rejects.toThrow("OAuth callback timed out");
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
});

it("a rejected refresh token deletes the login and needs a login", async () => {
  // log in once; then:
  server.expireAccessTokens();
  server.rejectRefreshTokens();
  const again = new OAuthConnector("linear", server.mcpUrl, store, { port, loginMode: "never" });
  await expect(again.connect()).rejects.toBeInstanceOf(NeedsLoginError);
  expect(await store.loadTokens("linear")).toBeUndefined();
  expect(await store.loadClientInfo("linear")).toBeDefined();
});

it("two calls at expiry both succeed and the login survives", async () => {
  const server = await startFakeOAuthServer({ rotateRefreshTokens: true, refreshDelayMs: 50 });
  // log in once and keep the connected client; then:
  server.expireAccessTokens();
  const [a, b] = await Promise.all([
    client.callTool({ name: "add", arguments: { a: 1, b: 2 } }),
    client.callTool({ name: "add", arguments: { a: 3, b: 4 } }),
  ]);
  expect(a.isError).toBeFalsy();
  expect(b.isError).toBeFalsy();
  expect(await store.loadTokens("linear")).toBeDefined();
  expect(server.refreshCount()).toBeGreaterThanOrEqual(2);
});

it("ask first still logs in", async () => {
  let url = "";
  const connector = new OAuthConnector("linear", server.mcpUrl, store, {
    port,
    onOAuthRequired: (data) => { url = data.authUrl; },
  });
  const connected = connector.connect();
  await vi.waitFor(() => expect(url).not.toBe(""));
  await completeLogin(url);
  const { client } = await connected;
  expect((await client.listTools()).tools.length).toBe(1);
  await client.close();
});
```

The "two calls at expiry" test must see two refresh requests. If `refreshCount()` is 1, the two calls did not overlap, and the test proves nothing. Raise `refreshDelayMs` until both calls refresh.

If that test fails with `Server returned 401 after successful authentication`, the cause is a flag in the SDK and not the refresh guard. The transport has one `_hasCompletedAuthFlow` flag for all its requests (`streamableHttp.js:25`, `:316-318`, `:332`, `:367`). A request that gets a 401 while the flag is set does not refresh. With the fake server both 401s arrive before either refresh finishes, so the test should not reach it.

That test depends on timing, so add one that does not. It drives the provider by hand, in `oauthProvider.test.ts`:

```ts
it("keeps a newer login when an older refresh token is rejected", async () => {
  await store.saveTokens("linear", { access_token: "a1", token_type: "bearer", refresh_token: "r1" });
  const provider = new AgencyOAuthProvider("linear", store, { loginMode: "never" });
  await provider.tokens();                                   // both calls read r1
  await provider.saveTokens({ access_token: "a2", token_type: "bearer", refresh_token: "r2" }); // call A refreshed
  await provider.tokens();                                   // call A builds its header
  provider.noteRejectedRefreshToken("r1");                   // call B was refused
  await provider.invalidateCredentials("tokens");
  expect((await store.loadTokens("linear"))?.refresh_token).toBe("r2");
});

it("deletes the login when its own refresh token is rejected", async () => {
  await store.saveTokens("linear", { access_token: "a1", token_type: "bearer", refresh_token: "r1" });
  const provider = new AgencyOAuthProvider("linear", store, { loginMode: "never" });
  provider.noteRejectedRefreshToken("r1");
  await provider.invalidateCredentials("tokens");
  expect(await store.loadTokens("linear")).toBeUndefined();
});
```

Three existing tests in `oauthProvider.test.ts` describe `prepare()` (lines 113 to 134). Replace them with one test: `redirectUrl` is `http://127.0.0.1:19876/oauth/callback` on a provider built with no options, with nothing started. Rewrite the `waitForAuthCode` test (line 153) to go through `OAuthConnector.startLogin`.

- [ ] **Step 2: Write `needsLogin.ts`, then change the provider and the connector.**
- [ ] **Step 3: Commit** with the message `OAuth: a mode that never starts a login, a login in two steps, and invalidateCredentials`.

### Task 5: The manager: records, modes, one login per process, log out, disconnect

**Files:**
- Modify: `packages/mcp/src/mcpManager.ts`
- Modify: `packages/mcp/tests/mcpManager.test.ts`

**Interfaces:**
- Consumes: `OAuthConnector` and `LoginMode` (Task 4), `NeedsLoginError` (Task 4), `TokenStore.deleteLogin` (Task 3).
- Produces:

```ts
export type ServerRecord =
  | { status: "connected"; tools: McpTool[] }
  | { status: "needsLogin" }
  | { status: "failed"; message: string };

class McpManager {
  setConfig(config: Record<ServerName, McpServerConfig>): void;  // replaces the whole map
  connectServer(serverName: string): Promise<ServerRecord>;      // never starts a login
  records(): Record<ServerName, ServerRecord>;                   // a copy; connects nothing
  startLogin(serverName: string): Promise<string>;               // the login page URL
  finishLogin(serverName: string): Promise<ServerRecord>;
  cancelLogin(serverName: string): Promise<void>;
  cancelAnyLogin(): Promise<void>;
  logout(serverName: string): Promise<void>;
  disconnectServer(serverName: string): Promise<void>;
  // existing, changed: getTools, callTool, disconnectAll
}
```

New fields on the instance:

- `serverRecords: Record<ServerName, ServerRecord>`. This replaces `toolCache`. A connected record holds the tools, so a second table of tools would be a copy that has to be kept in step. `getTools` returns `record.tools` for a connected record, which keeps the existing test that a second call returns the same array.
- `neverLogin: ServerName[]`: the servers a new method has been called for. `createConnection` passes `loginMode: "never"` for a name in this list, and `"askFirst"` otherwise.
- `pendingLogin: PendingLogin | null`, where `type PendingLogin = { serverName: string; connector: OAuthConnector }`.

Two private methods hold the bookkeeping, so that no public method edits `connections` and `serverRecords` by hand:

```ts
/** Close and forget the server's connection, if it has one. Then store `record`, or forget the record when `record` is null. */
private async replaceConnection(serverName: string, record: ServerRecord | null): Promise<void>;
/** Store a live connection and its connected record. Closes the connection it replaces. */
private async storeConnection(serverName: string, connection: McpConnection): Promise<ServerRecord>;
```

Every state change below is one call to one of these two.

Behavior:

- `connectServer` adds the name to `neverLogin`, connects, and stores and returns a record. A `NeedsLoginError` gives `{ status: "needsLogin" }`. Any other error gives `{ status: "failed", message }`, where `message` is the error's own message with no prefix. A name that is not in the config gives `{ status: "failed", message: 'MCP server "<name>" is not in the config' }`.
- `startLogin` adds the name to `neverLogin`, calls `cancelAnyLogin()`, builds a connector, calls its `startLogin()`, and stores it in `pendingLogin`. It throws for a server that is not an OAuth server.
- `finishLogin` throws `Error('no login in progress for <name>')` when `pendingLogin` is null or names another server. Otherwise it waits on the connector, calls `storeConnection`, and clears `pendingLogin`. When the connector rejects, it clears `pendingLogin`, leaves the record and the old connection as they were, and throws the same error.
- `cancelLogin(name)` does nothing unless `pendingLogin` names that server. `cancelAnyLogin()` cancels whatever is pending.
- `logout` calls `tokenStore.deleteLogin` and then `replaceConnection(name, { status: "needsLogin" })`.
- `disconnectServer` calls `replaceConnection(name, null)`.
- `callTool` has one `try` around both of its paths. It passes what it catches to `asNeedsLogin` (Task 4). On a `NeedsLoginError` it calls `replaceConnection(name, { status: "needsLogin" })` and throws the same error. Its message is already the text the spec gives.
- `getTools` keeps its behavior. On success it also stores a `connected` record, so `records()` covers servers that `mcp()` connected.
- `disconnectAll` also calls `cancelAnyLogin()` and empties `serverRecords`.

`OAuthConnector` needs the built connection wrapped in an `McpConnection`. `createConnection` (line 31) already does this with a `connector` function. For `finishLogin`, add a way to build an `McpConnection` from a client that is already connected, so the tools are listed the same way. `McpConnection.connect()` (`mcpConnection.ts:32`) lists tools after it connects. Pass a `connector` function that returns the finished client.

- [ ] **Step 1: Write the tests.** Use the fake OAuth server and `tokenStoreDir` set to a temporary folder. The manager has no `port` option today. Add `callbackPort?: number` to `McpManagerOptions` and pass it to each connector, so tests do not use 19876.

```ts
it("connectServer on a server with no saved login returns needsLogin", ...);
it("connectServer on a stdio server returns connected with its tools", ...);        // uses testServer.mjs
it("connectServer on a command that does not exist returns failed with the reason", ...);
it("records returns every server's record and connects nothing", ...);
it("startLogin then finishLogin returns connected and records it", ...);
it("a second login cancels the first", async () => {
  const urlA = await manager.startLogin("a");
  const urlB = await manager.startLogin("b");       // same callback port
  expect(urlB).toContain("state=");
  await expect(manager.finishLogin("a")).rejects.toThrow("no login in progress for a");
  const finished = manager.finishLogin("b");
  await completeLogin(urlB);
  expect((await finished).status).toBe("connected");
});
it("finishLogin with no login in progress throws", ...);
it("log in again, cancelled: the server stays connected and its login stays saved", ...);
it("logout keeps the registration, and a call after logout needs a login", async () => {
  // log in to "linear"; then:
  await manager.logout("linear");
  expect(fs.existsSync(path.join(dir, "linear.json"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "linear.client.json"))).toBe(true);
  await expect(manager.callTool("linear", "add", { a: 1, b: 2 })).rejects.toBeInstanceOf(NeedsLoginError);
  expect(manager.records().linear).toEqual({ status: "needsLogin" });
});
it("expiry on a live connection: the call fails and the record becomes needsLogin", async () => {
  // log in to "linear"; then:
  server.expireAccessTokens();
  server.rejectRefreshTokens();
  await expect(manager.callTool("linear", "add", { a: 1, b: 2 })).rejects.toThrow('MCP server "linear" needs a new login.');
  expect(manager.records().linear).toEqual({ status: "needsLogin" });
});
it("a call after the access token expires refreshes and succeeds", ...);
it("setConfig with a changed entry is used by the next connectServer", ...);
it("getTools on an untouched OAuth server still asks first", ...);                    // onOAuthRequired is called
it("getTools after connectServer for the same server does not start a login", ...);
it("disconnectAll cancels a login in progress", ...);                                // the callback port is free afterwards
```

- [ ] **Step 2: Change `mcpManager.ts`.**
- [ ] **Step 3: Commit** with the message `McpManager: per-server records, a no-login mode, one login per process, log out`.

### Task 6: The new exports, the version, and the `auth` command check

**Files:**
- Modify: `packages/mcp/src/mcp.ts`
- Modify: `packages/mcp/package.json` (version `0.0.6`)
- Create: `packages/mcp/tests/mcp.exports.test.ts`
- Modify: `packages/mcp/tests/mcp.raw.test.ts`

**Interfaces:**
- Consumes: the `McpManager` methods from Task 5.
- Produces, exported from `packages/mcp/src/mcp.ts`:

```ts
export type CallTool = (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;

export type ServerState =
  | { status: "connected"; tools: McpTool[]; callTool: CallTool }
  | { status: "needsLogin" }
  | { status: "failed"; message: string };

export type ConfigOption = { config: Record<string, McpServerConfig> };

export function connectServer(serverName: string, options: ConfigOption): Promise<ServerState>;
export function serverStates(): Promise<Record<string, ServerState>>;
export function startLogin(serverName: string, options: ConfigOption):
  Promise<{ status: "started"; authUrl: string } | { status: "failed"; message: string }>;
export function finishLogin(serverName: string): Promise<ServerState>;
export function cancelLogin(serverName: string): Promise<void>;
export function logout(serverName: string):
  Promise<{ status: "loggedOut" } | { status: "failed"; message: string }>;
export function disconnectServer(serverName: string): Promise<void>;
```

None of these throws. The seven functions do not each carry their own `try` and `catch`. One private helper holds it:

```ts
/** Run `action`. If it throws, log the error and return `onError(message)`. */
async function orElse<T>(what: string, action: () => Promise<T>, onError: (message: string) => T): Promise<T>;
```

It logs with `console.error("[mcp] " + what + " failed: " + message)`, as `McpManager.getTools` does at line 78. Each export is then one call that says what it wants. For example:

```ts
export function logout(serverName: string) {
  return orElse(
    `log out of "${serverName}"`,
    async () => {
      await getManager().logout(serverName);
      return { status: "loggedOut" as const };
    },
    failed,
  );
}
```

`failed` is `(message: string) => ({ status: "failed" as const, message })`. `cancelLogin` and `disconnectServer` return nothing, so their `onError` returns `undefined`, and the helper has still logged the error.

A second private function, `toServerState(record: ServerRecord): ServerState`, adds `callTool` to a connected record. `connectServer`, `finishLogin`, and `serverStates` all use it.

`getManager` changes in two ways. A call with a `config` on an existing manager calls `manager.setConfig(config)` in place of the warning at line 46. A call without a `config` leaves the stored config alone. The warning about `onOAuthRequired` stays.

`serverStates()` returns `{}` when no manager exists yet. It does not create one.

`finishLogin` turns the manager's errors into `{ status: "failed", message }` through `orElse`, with the error's message unchanged. A cancel already has the message `login cancelled` (Task 2), and no login in progress already has `no login in progress for <name>` (Task 5). Do not match on message text anywhere.

- [ ] **Step 1: Write `mcp.exports.test.ts`.** The manager is one per process, so call `disconnectServer` for each name at the end of each test, and use a different server name in each test.

```ts
it("connectServer returns needsLogin for a server with no saved login", ...);
it("serverStates gives a connected server a callTool that works", ...);
it("startLogin returns started with a URL, and finishLogin returns connected", ...);
it("cancelLogin makes a waiting finishLogin return failed with 'login cancelled'", ...);
it("finishLogin with no login in progress returns the no-login failure", ...);
it("logout returns loggedOut", ...);
it("a later call with a changed config uses the new config", ...);
it("mcpRaw without a config leaves the stored config alone", ...);
it("mcpRaw on an untouched OAuth server with no saved login still logs in", ...);  // pass onOAuthRequired, then completeLogin
```

These tests cannot choose the callback port, because the exports take none. They use the real port, 19876. Do not add an environment variable or an option to the package only so that a test can change the port. Keep every test that starts a login in this one file, so no two of them run at the same time. Tasks 2, 4, and 5 pass their own free port and are not affected.

- [ ] **Step 2: Add the exports and bump the version.** `mcp.raw.test.ts` reads the version from `package.json`, so it needs no change for the bump. Change it only if `getManager`'s new behavior breaks its first test.
- [ ] **Step 3: Check the `auth` command by reading it.** `packages/mcp/src/cli.ts:60-67` calls `new OAuthConnector(...).connect()` with no `loginMode`. With Task 4 that is "ask first", which the "ask first still logs in" test covers. Confirm `cli.ts` compiles with no change.
- [ ] **Step 4: Build and run the whole package suite once,** with the two commands under "How to test", PR 1. Fix what fails. Do not push with a failing test.
- [ ] **Step 5: Commit** with the message `@agency-lang/mcp 0.0.6: connect without a login, log in from a menu, log out`.
- [ ] **Step 6: Open PR 1 and stop.** Write the description to a file and pass it with `--body-file`. Say in it that the owner publishes 0.0.6 after the merge, and that PR 2 depends on the published version.

---

# PR 2: agency-lang

Tasks 7 to 12. PR 2 has its own branch. A commit pushed to `adit/mcp-login-menu` while PR 1 is open would join PR 1.

1. After PR 1 is open, create `adit/mcp-login-menu-agent` from `adit/mcp-login-menu`, in this same worktree: `git switch -c adit/mcp-login-menu-agent`.
2. Open PR 2 with `adit/mcp-login-menu` as its base.
3. A fix that PR 1's review asks for goes on `adit/mcp-login-menu`. Then merge that branch into `adit/mcp-login-menu-agent`.
4. After PR 1 merges, merge `origin/main` into `adit/mcp-login-menu-agent` and change PR 2's base to `main`.

Never rebase either branch. Before each commit in these tasks, `git branch --show-current` must print `adit/mcp-login-menu-agent`.

### Task 7: The bridge

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/mcpBridge.mjs`
- Modify: `packages/agency-lang/lib/stdlib/mcpBridge.d.mts`
- Modify: `packages/agency-lang/lib/stdlib/mcpBridge.contract.test.ts`

**Interfaces:**
- Consumes: the package exports from Task 6.
- Produces, in the bridge, one pass-through for each: `connectServer`, `serverStates`, `startLogin`, `finishLogin`, `cancelLogin`, `logout`, `disconnectServer`. Each has the package's signature. `mcpBridge.d.mts` declares them with these structural types, since agency-lang cannot import the package's types:

```ts
export type BridgeCallTool = (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
export type BridgeServerState =
  | { status: "connected"; tools: { name: string; description?: string }[]; callTool: BridgeCallTool }
  | { status: "needsLogin" }
  | { status: "failed"; message: string };
```

- [ ] **Step 1: Add contract tests** that need no server:

```ts
it("serverStates returns an object", async () => {
  expect(typeof (await bridge.serverStates())).toBe("object");
});
it("connectServer returns failed for a server that is not in the config", async () => {
  const state = await bridge.connectServer("no-such-server", { config: {} });
  expect(state.status).toBe("failed");
});
it("finishLogin with no login in progress returns the no-login failure", async () => {
  expect(await bridge.finishLogin("linear")).toEqual({ status: "failed", message: "no login in progress for linear" });
});
it("startLogin returns failed for a server that is not in the config", async () => {
  expect((await bridge.startLogin("no-such-server", { config: {} })).status).toBe("failed");
});
```

- [ ] **Step 2: Add the pass-throughs and declarations.** Update the comment at the top of `mcpBridge.mjs` that lists what it exposes.
- [ ] **Step 3: Commit** with the message `mcpBridge: pass-throughs for the 0.0.6 exports`.

### Task 8: The version check

**Files:**
- Create: `packages/agency-lang/lib/stdlib/mcpVersion.ts`
- Create: `packages/agency-lang/lib/stdlib/mcpVersion.test.ts`

**Interfaces:**
- Produces:

```ts
export const MIN_MCP_VERSION = "0.0.6";
/** True when `found` is `wanted` or newer. Compares the three dotted numbers and ignores any suffix after them. A string that is not a version is older than everything. */
export function versionAtLeast(found: string, wanted: string): boolean;
/** The text shown to the user, or "" when `found` is new enough. */
export function packageProblem(found: string): string;
```

For `found = "0.0.5"`, `packageProblem` returns exactly `@agency-lang/mcp 0.0.5 is too old. Run: npm install -g @agency-lang/mcp@latest`.

- [ ] **Step 1: Write the tests:** `versionAtLeast("0.0.6", "0.0.6")` is true, `"0.0.5"` is false, `"0.1.0"` is true, `"1.0.0"` is true, `"0.0.10"` is true, `"0.0.6-beta.1"` is true, `""` is false, `"abc"` is false. `packageProblem("0.0.5")` is the string above, and `packageProblem("0.0.6")` is `""`.
- [ ] **Step 2: Write the file.**
- [ ] **Step 3: Commit** with the message `Add the minimum @agency-lang/mcp version check`.

### Task 9: The `std::mcp` functions

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/mcp.ts`
- Modify: `packages/agency-lang/lib/stdlib/mcp.test.ts`
- Modify: `packages/agency-lang/stdlib/mcp.agency`
- Create: `packages/agency-lang/tests/agency/mcp-logout.agency`
- Create: `packages/agency-lang/tests/agency/mcp-logout.test.json`

**Interfaces:**
- Consumes: the bridge (Task 7), `packageProblem` (Task 8), `gate` from `lib/stdlib/mcpGate.ts`, `leafCancel` from `lib/stdlib/abortable.ts`, `currentRun` from `lib/runtime/asyncContext.ts`.
- Produces, in `lib/stdlib/mcp.ts`:

```ts
export type McpServerState = {
  name: string;
  status: "connected" | "needsLogin" | "failed";
  message: string;          // "" unless status is "failed"
  tools: AgencyFunction[];  // [] unless status is "connected"
};

export function _mcpPackageProblem(): Promise<string>;
export function _connectMcpServers(merged: RawMcpServers): Promise<McpServerState[]>;
export function _mcpServerStates(): Promise<McpServerState[]>;
export function _startMcpLogin(merged: RawMcpServers, name: string): Promise<ResultValue>; // success(url) or failure(message)
export function _finishMcpLogin(name: string): Promise<McpServerState>;
export function _cancelMcpLogin(name: string): Promise<void>;
export function _logoutMcpServer(name: string): Promise<ResultValue>;
export function _reconnectMcpServer(merged: RawMcpServers, name: string): Promise<McpServerState>;
```

- Produces, in `stdlib/mcp.agency`, the type `McpServerState` as the spec gives it, the effect, and eight exported functions:

```
@always(server)
effect mcp::logout {
  server: string
}
```

| Agency function | Calls | `@capabilities` |
|---|---|---|
| `mcpPackageProblem(): string` | `_mcpPackageProblem` | none |
| `connectMcpServers(merged: Record<string, any>): McpServerState[]` | `_connectMcpServers` | `fileRead, fileWrite, network, subprocess` |
| `mcpServerStates(): McpServerState[]` | `_mcpServerStates` | none |
| `startMcpLogin(merged: Record<string, any>, name: string): Result<string>` | `_startMcpLogin` | `fileRead, fileWrite, network` |
| `finishMcpLogin(name: string): McpServerState` | `_finishMcpLogin` | `fileRead, fileWrite, network` |
| `cancelMcpLogin(name: string)` | `_cancelMcpLogin` | `network` |
| `logoutMcpServer(name: string): Result raises <mcp::logout>` | the interrupt, then `_logoutMcpServer` | `fileWrite, network` |
| `reconnectMcpServer(merged: Record<string, any>, name: string): McpServerState` | `_reconnectMcpServer` | `fileRead, fileWrite, network, subprocess` |

If `--check-capabilities` asks for a different set on any of them, use what it asks for and say so in the PR description.

`logoutMcpServer` follows the shape of `openUrl` in `stdlib/system.agency:182-192`:

```
@capabilities(fileWrite, network)
export def logoutMcpServer(name: string): Result raises <mcp::logout> {
  """
  Delete the saved login for an MCP server and disconnect from it.

  @param name - The server's name in the mcpServers config.
  """
  return interrupt mcp::logout("Are you sure you want to log out of this MCP server?", {
    server: name
  })

  return try _logoutMcpServer(name)
}
```

Every function gets a docstring written for a model that may be handed the function as a tool. See `docs/dev/contributing/docstrings-vs-doccomments.md`. Update the module comment at the top of `stdlib/mcp.agency` to mention server states and logins.

Behavior of the TypeScript side:

- No function checks for the package by itself. One private helper holds the check:

```ts
/** Why the package cannot be used, or "" when it can: not installed, or too old. */
async function unusable(): Promise<string>;

/** Run `action` when the package can be used. Otherwise return `whenUnusable(reason)`. */
async function withPackage<T>(whenUnusable: (reason: string) => T, action: () => Promise<T>): Promise<T>;
```

  `unusable()` returns `@agency-lang/mcp is not installed. Run: npm install @agency-lang/mcp` when `isMcpAvailable()` is false, and `_mcpPackageProblem()` otherwise. `withPackage` also calls `exposeResolvedMcpPath()` before `action`. Each function is one `withPackage` call that states its own fallback: `() => []` for the two list functions, `failure` for the two `Result` functions, and `(reason) => failedState(name, reason)` for `_finishMcpLogin` and `_reconnectMcpServer`. `_cancelMcpLogin` passes `() => undefined`. A later function added to this file gets the check by using the same helper.
- `failedState(name: string, message: string): McpServerState` builds `{ name, status: "failed", message, tools: [] }`.
- `_mcpPackageProblem` returns `""` when the package is not installed, and `packageProblem(await mcpBridge.packageVersion())` otherwise. A version read that throws gives `packageProblem("")`.
- One private function turns a `BridgeServerState` into an `McpServerState`. For `connected`, it gates the record's `callTool` with `gate` and wraps each tool with `mcpBridge.mcpToolToAgencyFunction`, as `_loadMcpToolsForServer` does at lines 100 to 106. All the functions use it.
- `_connectMcpServers` connects every server at the same time with `Promise.all` over `Object.keys(merged)`, and returns the states in that order. Do not copy the "first server alone" step from `_loadMcpToolsWithStatus` (lines 128 to 138). That step guards the creation of the package's manager, and `getManager` in the package is synchronous, so two calls cannot both create one.
- `_mcpServerStates` returns one entry per key of `bridge.serverStates()`, in key order.
- `_reconnectMcpServer` calls `bridge.disconnectServer(name)` and then `bridge.connectServer(name, { config: merged })`.
- `_finishMcpLogin` takes the run on its first line, before `withPackage` and before any other `await`: `const run = currentRun(); const signal = run.ctx.getAbortSignal(run.stack);`. `currentRun()` throws after a function's first `await` (`lib/runtime/asyncContext.ts:337-348`), and `withPackage` awaits. `getRuntimeContext` is the deprecated name for the same function, so do not use it in new code. If the signal is already aborted, it calls `bridge.cancelLogin(name)` and throws `leafCancel("MCP login cancelled", signal)`. Otherwise it listens for `abort`, and the listener calls `bridge.cancelLogin(name)`. After `bridge.finishLogin(name)` returns, it removes the listener. If the signal is aborted by then, it throws `leafCancel("MCP login cancelled", signal)`. Otherwise it returns the state.

- [ ] **Step 1: Extend the bridge mock** at the top of `lib/stdlib/mcp.test.ts` with the seven new functions, and change `packageVersion` to return `"0.0.6"`. Check the existing tests in the file still describe `_loadMcpTools` correctly with that version.
- [ ] **Step 2: Add the tests:**

```ts
describe("_mcpPackageProblem", () => {
  it("is empty for 0.0.6", ...);
  it("names the version and the command for 0.0.5", async () => {
    (bridge.packageVersion as any).mockResolvedValueOnce("0.0.5");
    expect(await _mcpPackageProblem()).toBe(
      "@agency-lang/mcp 0.0.5 is too old. Run: npm install -g @agency-lang/mcp@latest",
    );
  });
  it("is empty when the package is not installed", ...);
});

describe("_connectMcpServers", () => {
  it("returns one state per server, in config order", ...);       // connected, needsLogin, failed
  it("gates a connected server's tools", ...);                    // mcpToolToAgencyFunction called once per tool
  it("returns [] when the package is too old", ...);
  it("returns [] when the package is not installed", ...);
});

describe("_startMcpLogin", () => {
  it("returns success with the URL", ...);
  it("returns failure with the package's message", ...);
});

describe("_finishMcpLogin", () => {
  it("returns the connected state", ...);
  it("cancels the login and throws the cancel error when the run is aborted", ...);
});

describe("_reconnectMcpServer", () => {
  it("disconnects, then connects", ...);                          // check the call order
});

describe("_logoutMcpServer", () => {
  it("returns success for loggedOut and failure for failed", ...);
});
```

For the abort test, use `runInTestContext` from `lib/runtime/asyncContext.ts:444`, which makes a run from a context, a stack, and a thread store, and calls a function with it. The run is current only until that function's first `await`, so call `_finishMcpLogin` directly inside it. Make the mocked `bridge.finishLogin` wait until `bridge.cancelLogin` is called and then resolve with `{ status: "failed", message: "login cancelled" }`.

- [ ] **Step 3: Write the Agency test for the effect.** `tests/agency/mcp-logout.agency` has two nodes and makes no call that needs the package:

```
import { logoutMcpServer } from "std::mcp"

node rejectedLogoutFails(): boolean {
  const result = logoutMcpServer("linear") with reject
  return isFailure(result)
}

node raisesTheLogoutEffect(): string {
  let seen = ""
  handle {
    logoutMcpServer("linear")
  } with (intr) {
    seen = "${intr.effect}:${intr.data.server}"
    return reject()
  }
  return seen
}
```

Expected outputs: `true` and `"mcp::logout:linear"`. Check the handler syntax against `docs/site/guide/handlers.md` and run `pnpm run ast tests/agency/mcp-logout.agency` to confirm it parses. If a handler body cannot assign to an outer `let`, return the text another way that the guide shows.

- [ ] **Step 4: Write the TypeScript functions and the Agency functions.**
- [ ] **Step 5: Commit** with the message `std::mcp: server states, a login in two steps, log out, and reconnect`.

### Task 10: A fake package for the agent tests

**Files:**
- Create: `packages/agency-lang/lib/agents/agency-agent/tests/fakeMcpPackage.mjs`

**Interfaces:**
- Produces: a module with the exports the bridge calls: `MCP_PACKAGE_VERSION` (`"0.0.6"`), `readMcpConfig`, `validateMcpServers`, `mcpToolToAgencyFunction`, `mcpRaw`, `connectServer`, `serverStates`, `startLogin`, `finishLogin`, `cancelLogin`, `logout`, `disconnectServer`.

The fake decides a server's behavior from its config, so each test controls it through the config it passes:

| Config | Behavior |
|---|---|
| `{ command: "ok" }` | Connects with one tool, `<name>__echo`. |
| `{ command: "missing" }` | `failed` with the message `spawn missing ENOENT`. |
| `{ type: "http", url: ..., auth: "oauth" }` | `needsLogin` until a login finishes, then connected with one tool, `<name>__echo`. |

`startLogin(name)` returns `{ status: "failed", message: "<name> is not an OAuth server" }` for a server whose config has no `auth: "oauth"`. Otherwise it returns `{ status: "started", authUrl: "https://login.example/authorize?server=<name>" }`, cancels any earlier login, and records `name` as the pending login. `finishLogin(name)` returns the connected state when `name` is the pending login, and `{ status: "failed", message: "no login in progress for <name>" }` otherwise. So a login completes in the fake with no browser. `logout(name)` sets the server back to `needsLogin`.

The fake keeps its records in module state. That is allowed in this test file: it stands in for the package's manager, which is also one per process.

`mcpToolToAgencyFunction` must return a real `AgencyFunction`. Import the class from `agency-lang/runtime` the way `packages/mcp/src/toolAdapter.ts:45-69` builds one. If that import does not resolve from this folder, import the built package's `mcpToolToAgencyFunction` from `packages/mcp/dist/src/mcp.js` by relative path and re-export it.

- [ ] **Step 1: Write the file.**
- [ ] **Step 2: Commit** together with Task 11.

### Task 11: The agent: startup and the `/mcp` menu

**Files:**
- Modify: `packages/agency-lang/lib/agents/agency-agent/lib/mcp.agency`
- Create: `packages/agency-lang/lib/agents/agency-agent/lib/mcpMenu.agency`
- Modify: `packages/agency-lang/lib/agents/agency-agent/lib/repl.agency:30` and `:322`
- Create: `packages/agency-lang/lib/agents/agency-agent/tests/mcpMenu.agency`
- Create: `packages/agency-lang/lib/agents/agency-agent/tests/mcpMenu.test.json`
- Modify: `packages/agency-lang/lib/agents/agency-agent/tests/toolPresentations.agency` only if it breaks

**Interfaces:**
- Consumes: the eight `std::mcp` functions and `McpServerState` (Task 9). `openUrl` from `std::system`. `chooseOption`, `ChoiceItem`, and `pushMessage` from `std::ui/cli`. `getMcpServers` and `loadSettings` from `./settings.agency`. The fake package (Task 10).
- Produces, in `lib/mcp.agency`:

```
export def mergedMcpServers(settings: Settings): Record<string, any>
export def stateLine(state: McpServerState): string
export def startupLines(problem: string, states: McpServerState[]): string[]
export def maybeLoadMcp(settings: Settings)
export def getMcpTools(): any[]
```

- Produces, in `lib/mcpMenu.agency`:

```
export type RowStatus = "connected" | "needsLogin" | "failed" | "notConnected"

export type ServerRow = {
  name: string;
  config: Record<string, any>;
  scope: "project" | "global";
  status: RowStatus;
  message: string;
  tools: any[]
}

export def serverRows(globalServers: Record<string, any>, projectServers: Record<string, any>, states: McpServerState[]): ServerRow[]
export def statusText(row: ServerRow): string
export def detailLines(row: ServerRow, projectFile: string, globalFile: string): string[]
export def actionsFor(row: ServerRow): ChoiceItem[]
export def beginLogin(merged: Record<string, any>, name: string): Result<string[]>
export def endLogin(name: string): string
export def logOut(name: string): string
export def reconnect(merged: Record<string, any>, name: string): string
export def toolLines(row: ServerRow): string[]
export def runAction(key: string, row: ServerRow, merged: Record<string, any>): string[]
export def mcpSlashCommand(): boolean
```

**`lib/mcp.agency`.** Delete the globals `mcpTools` and `mcpServerStatus`, the functions `setMcpTools`, `setMcpServerStatus`, and `onMcpOAuth`, and the old `mcpSlashCommand`. Rewrite the module comment and the comment about the ordering contract: the file no longer holds tools.

- `mergedMcpServers` is the merge both callers do today: `mergeMcpServers(getMcpServers(settings), readProjectMcpConfig(cwd()))`.
- `stateLine` is the one place a server's state becomes a sentence. Startup, a finished login, and a reconnect all use it:

| Status | Line |
|---|---|
| `connected` | `✔ <name> connected · <n> tools. You can use them from your next message.` |
| `needsLogin` | `<name> needs you to log in.` |
| `failed` | `<name> failed to connect: <message>` |

- `startupLines` returns `["MCP: ${problem}"]` when `problem` is not empty. Otherwise it returns one line per state that is not connected, in order: `MCP: ` and then `stateLine(state)`. A `needsLogin` line also gets ` Type /mcp to log in.` at the end. That gives the two lines the spec shows:
  - `MCP: linear needs you to log in. Type /mcp to log in.`
  - `MCP: github failed to connect: connect ECONNREFUSED 127.0.0.1:3000`
- `maybeLoadMcp` returns at once when `isMcpAvailable()` is false or no servers are configured. Otherwise it reads `mcpPackageProblem()`, calls `connectMcpServers(merged)` when there is no problem, and prints each of `startupLines(...)` in yellow.
- `getMcpTools` returns the tools of every state in `mcpServerStates()`, in order.

**`lib/mcpMenu.agency`.**

- `serverRows` returns one row per server in the merged config, in the merged config's key order. `scope` is `"project"` when the name is a key of `projectServers`, and `"global"` otherwise. The status comes from the state with the same name. A server with no state has the status `"notConnected"`. A state with no server in the config gets no row.
- `statusText` returns the text after the name in the list. Keep the three fixed texts in one `const` object keyed by status, and add the tool count for a connected row:

| Status | Text |
|---|---|
| `connected` | `✔ connected · <n> tools` |
| `needsLogin` | `! needs login` |
| `failed` | `✘ failed` |
| `notConnected` | `○ not connected` |

- `detailLines` returns the lines above the actions on a server's screen:
  - `Status:  <statusText>`, with `: <message>` added for a failed server.
  - `URL:     <url>` for an HTTP server, or `Command: <command and args joined by spaces>` for a stdio server.
  - `Config:  <projectFile> (project)` or `Config:  <globalFile> (global)`.
- `actionsFor` returns the actions for a row. The lists are data: one `const` object, `ACTIONS`, keyed by the kind of row, holding a `ChoiceItem[]` for each kind. `actionsFor` works out the kind and returns the list. A new action or a new kind of row is then a change to `ACTIONS` and to nothing else.

| Kind of row | Actions, as `key` and label, in order |
|---|---|
| `needsLogin` | `login` "Log in", `reconnect` "Reconnect", `back` "Back" |
| `connectedOAuth` | `tools` "View tools", `login` "Log in again", `logout` "Log out", `reconnect` "Reconnect", `back` "Back" |
| `connected` | `tools` "View tools", `reconnect` "Reconnect", `back` "Back" |
| `failed` | `reconnect` "Reconnect", `back` "Back" |
| `notConnected` | `reconnect` "Connect", `back` "Back" |

  The kind is the row's status, except that a connected row whose config has `auth == "oauth"` is `connectedOAuth`. Only an OAuth server can have the status `needsLogin`, so that row needs no check of the config.

- `beginLogin` calls `startMcpLogin(merged, name)` and returns its failure unchanged. On success it calls `openUrl(url)` and ignores a failure from it, then returns these three lines:

```
Opening the <name> login page in your browser.
If it doesn't open, visit: <url>
Waiting for you to finish logging in. Press Escape to cancel.
```

  Do not wrap `openUrl` in `with approve`. The spec's section "Logging in" says why.
- `endLogin` returns `stateLine(finishMcpLogin(name))`.
- `reconnect` returns `stateLine(reconnectMcpServer(merged, name))`.
- `logOut` calls `logoutMcpServer(name)`. It returns `<name> logged out.` on success and `<name>: <the failure's message>` on failure. A rejected `mcp::logout` is a failure.
- `runAction(key: string, row: ServerRow, merged: Record<string, any>): string[]` is the one place an action key becomes a call. It is a `match` on the key, and it returns the lines to show. The menu loop calls it and knows nothing about any one action. `login` is the only action that must show lines before it finishes, so its arm pushes the lines from `beginLogin` itself and returns `[endLogin(row.name)]`. When `beginLogin` fails, the arm returns `["<name>: <the failure's message>"]` and does not call `endLogin`.
- `toolLines` returns one line per tool: its name, two spaces, and the first line of its description.
- `mcpSlashCommand` keeps the first two checks the old one has, with their exact messages ("MCP is not installed. Run: npm install @agency-lang/mcp" and "No MCP servers configured. Add an mcpServers block to agency.json or settings.json."). Then it prints `MCP: <problem>` and returns when `mcpPackageProblem()` is not empty. Otherwise it loops:
  1. Build the rows and show the list with `chooseOption("MCP servers", "", items, allowCancel: true)`. Each item's key is the server name and its label is the name and `statusText`. An empty answer or `null` leaves the menu.
  2. Show the server's screen: `chooseOption(<name>, <detailLines joined by newlines>, actionsFor(row), allowCancel: true)`. An empty answer, `null`, or `back` returns to step 1.
  3. Push each line `runAction` returns with `pushMessage`, and go to step 1.

  It always returns `true`. `lib/agents/agency-agent/lib/capabilitiesUi.agency:167-183` shows `chooseOption` with `allowCancel`.

  The project file's path is `agency.json` in `cwd()`. Find the name for the global file in `settings.agency` (`SETTINGS_PATH`) and use it.

**`lib/repl.agency`.** Import `mcpSlashCommand` from `./mcpMenu.agency` in place of `./mcp.agency`. Line 322 does not change.

- [ ] **Step 1: Write the tests** in `tests/mcpMenu.agency`. Follow `tests/jobsSlash.agency` for the shape of a test file and its `.test.json`. The test file has three helpers, so that no node repeats the setup:

```
// Point std::mcp at the fake package. Every node that reaches the package calls this first.
def useFakePackage() {
  setEnv("AGENCY_MCP_PATH", "${cwd()}/lib/agents/agency-agent/tests/fakeMcpPackage.mjs") with approve
}

// A config with one OAuth server.
def oauthServer(name: string): Record<string, any> {
  let servers: Record<string, any> = {}
  servers[name] = { type: "http", url: "https://${name}.example/mcp", auth: "oauth" }
  return servers
}

// Log in the way the menu does. The open is rejected, so no browser opens.
def logIn(merged: Record<string, any>, name: string): string {
  handle {
    beginLogin(merged, name)
  } with (intr) {
    return reject()
  }
  return endLogin(name)
}
```

`toolCount`, shown further down, is the fourth. Confirm `cwd()` is `packages/agency-lang` under `agency test`. If it is not, build the path from what it is.

The bridge loads the package once per process, so all the nodes in this file share one fake. Give every node its own server names.

| Node | Does | Expected |
|---|---|---|
| `startupLinesForEachStatus` | `startupLines("", [connected, needsLogin "linear", failed "github" with "connect ECONNREFUSED 127.0.0.1:3000"])` | `["MCP: linear needs you to log in. Type /mcp to log in.", "MCP: github failed to connect: connect ECONNREFUSED 127.0.0.1:3000"]` |
| `startupLineForAnOldPackage` | `startupLines("@agency-lang/mcp 0.0.5 is too old. Run: npm install -g @agency-lang/mcp@latest", [])` | one line, that text after `MCP: ` |
| `rowsMarkProjectAndNotConnected` | `serverRows` with one global server, one project server of the same name, one more global server, and a state for only the first | scopes `["project", "global"]`, statuses `["connected", "notConnected"]` |
| `rowsSkipAStateWithNoConfig` | `serverRows({}, {}, [a connected state])` | `[]` |
| `stateLineForEachStatus` | `stateLine` for a connected state with two tools, a `needsLogin` state, and a failed state, all named `"s"` | `["✔ s connected · 2 tools. You can use them from your next message.", "s needs you to log in.", "s failed to connect: boom"]` |
| `actionsForEachRow` | the keys from `actionsFor` for the five kinds of row in the table above | the five key lists |
| `loginAddsTheTools` | `connectMcpServers(oauthServer("t1"))`, then `logIn`, then `toolCount("t1")` | `1` |
| `rejectedOpenStillShowsTheUrl` | `beginLogin` for `"t2"` inside a handler that rejects `std::openUrl`; return the second line | `"If it doesn't open, visit: https://login.example/authorize?server=t2"` |
| `logoutRemovesTheTools` | `logIn` to `"t3"`, then `logOut("t3") with approve`, then `toolCount("t3")` | `0` |
| `rejectedLogoutKeepsTheTools` | `logIn` to `"t4"`, then `logOut("t4") with reject`, then `toolCount("t4")` | `1` |
| `abandonedLoginDoesNotBlockTheNext` | `beginLogin` for `"t5"` inside a rejecting handler and never finish it; then `logIn` to `"t6"`; return whether the line starts with `✔ t6 connected` | `true` |
| `connectsAServerWithNoState` | `reconnect(merged, "t7")` for a `{ command: "ok" }` server that was never connected | `"✔ t7 connected · 1 tools. You can use them from your next message."` |
| `failedLoginStartSaysWhy` | `runAction("login", row, merged)` for a row named `"t10"` whose config is `{ command: "ok" }`, which the fake refuses to start a login for with the message `t10 is not an OAuth server` | `["t10: t10 is not an OAuth server"]` |
| `failedServerSaysWhy` | `reconnect(merged, "t8")` for a `{ command: "missing" }` server | `"t8 failed to connect: spawn missing ENOENT"` |
| `toolsSurviveARestore` | see below | `1` |

`toolsSurviveARestore` checks that no Agency global holds the tools. `tests/agency/maxRestores.agency` shows `checkpoint()` and `restore()`.

```
// How many of the session's MCP tools belong to one server.
def toolCount(server: string): number {
  let count = 0
  for (tool in getMcpTools()) {
    if (tool.name.startsWith("${server}__")) {
      count = count + 1
    }
  }
  return count
}

node toolsSurviveARestore(): number {
  useFakePackage()
  const merged = oauthServer("t9")
  connectMcpServers(merged)
  const cp = checkpoint()
  const count = toolCount("t9")
  if (count == 0) {
    logIn(merged, "t9")
    restore(cp, { maxRestores: 1 })
  }
  return count
}
```

The first pass counts 0, logs in, and restores to the checkpoint. The second pass counts the tools again. The login happened in TypeScript, which a restore does not undo, so the count is 1. With the tools in an Agency global, the restore would bring back the empty list and the test would loop to its restore limit. The other nodes in the file use `toolCount` too.

- [ ] **Step 2: Rewrite `lib/mcp.agency` and write `lib/mcpMenu.agency`.**
- [ ] **Step 3: Check `tests/toolPresentations.agency`.** It calls `getMcpTools()` at line 23. With no package installed it returns `[]`, as before. Change the test only if it fails.
- [ ] **Step 4: Run `agency fmt -i`** on the three new `.agency` files only: `lib/mcpMenu.agency`, `tests/mcpMenu.agency`, and `tests/agency/mcp-logout.agency`. Do not run it on `lib/mcp.agency` or `lib/repl.agency`.
- [ ] **Step 5: Commit** with the message `agency agent: connect MCP servers without a login, and add the /mcp menu`.

### Task 12: Docs, the full check, and the PR

**Files:**
- Create: `packages/agency-lang/docs/dev/agents/agent-mcp.md`
- Modify: `packages/agency-lang/CLAUDE.md` (one index line under "Agents")
- Modify: `packages/agency-lang/docs/dev/agents/user-commands.md`
- Modify: `packages/agency-lang/docs/dev/security/roadmap.md`
- Modify: `packages/agency-lang/docs/dev/agents/agent-sessions.md` only if its sentence about MCP connections is now wrong

- [ ] **Step 1: Write `agent-mcp.md`.** It describes the mechanism and the rules. It has no history and no account of how the work went. Cover, each in a short section:
  - Where server state lives: the package's manager, one per process. No Agency global holds it, and why (`agent-sessions.md`, "How a resume works").
  - The two login modes, and the rule that a server a new function has touched never starts a login on its own.
  - The login in two steps, with the `std::openUrl` question between them, and why the timeout is counted from `finishMcpLogin`.
  - One login per process, and that a new login cancels the one in progress.
  - What a tool call does when a login expired: refresh, or "needs a new login" and the status change.
  - The `mcp::logout` effect, and that the menu asks twice.
  - The menu's list comes from the config, and what "not connected" means.
  - The version check and `mcpPackageProblem()`.
  - The files, as a table.
  - How interrupts behave: which calls raise, that no handler is skipped, and that nothing here is saved in a checkpoint.

  Follow `~/.claude/skills/simplify-speech/general-writing-tips.md`, then check the draft against `~/.claude/skills/simplify-speech/verbal-tics.md`.

- [ ] **Step 2: Add the index line** to `CLAUDE.md` in the "Agents" list. It is one sentence of at most 150 characters:

```
- `docs/dev/agents/agent-mcp.md` — How `agency agent` connects to MCP servers, the `/mcp` menu's login and log out, and where server state lives.
```

- [ ] **Step 3: Add one line to `user-commands.md`** saying that `/mcp` opens the MCP server menu and that `agent-mcp.md` describes it. Put it where the doc covers the other slash commands.
- [ ] **Step 4: Add the gap to `roadmap.md`.** Read the doc's first section to see how an item is written, and add an item in section A ("The only door is the standard library"), with a row in the Status table. The gap: `loadMcpTools`, `loadMcpToolsWithStatus`, `connectMcpServers`, `reconnectMcpServer`, and `startMcpLogin` take a server config as a value and raise no interrupt, so a program that hands one of them to a model lets the model choose the command a stdio server runs. There is no issue number. Write "none" in the Issue column.
- [ ] **Step 5: Run the whole PR 2 check once,** with the commands under "How to test". `make` also regenerates `docs/site/stdlib/mcp.md` from the docstrings. Commit that generated file if it changed. Fix what fails, and typecheck again after every fix.
- [ ] **Step 6: Check the diff against `docs/dev/contributing/anti-patterns.md`,** and read every comment you added. Cut any comment that restates the code.
- [ ] **Step 7: Format the changed TypeScript files by name** with `pnpm exec prettier --write`.
- [ ] **Step 8: Commit** with the message `Docs: how the agent connects to MCP servers and logs in`.
- [ ] **Step 9: Open PR 2 and stop.** Write the description to a file. Say in it:
  - It needs `@agency-lang/mcp` 0.0.6 to be published first. Until a user upgrades, the agent connects no MCP servers and prints the upgrade line.
  - The user guide page `docs/site/guide/mcp.md` is not changed and now describes the old login. Ask whether to update it.
  - Any capability tag that differs from the table in Task 9.

  The owner merges. After the PR is open, watch its CI and fix failures on the same branch.

---

## What the plan checks by reading and not by running

These are places where I read the code and could not run it. Confirm each one early in its task. If one is wrong, stop and say so before you build around it.

1. **Task 1:** the exact discovery paths and fields the SDK asks the fake server for.
2. **Tasks 4 and 5:** whether an error thrown in `redirectToAuthorization` comes out of `client.connect()` and out of `client.callTool()` unchanged or wrapped. The two paths differ inside the SDK. The first test in Task 4 answers it for `connect`, and "expiry on a live connection" in Task 5 answers it for `callTool`.
3. **Task 4:** whether two `callTool` requests on one client really refresh at the same time. The test checks `refreshCount()` for this reason.
4. **Task 9:** how a vitest test supplies a runtime context with an abort signal.
5. **Task 10:** whether a `.mjs` file in the agent's test folder can import `AgencyFunction` from `agency-lang/runtime`.
6. **Task 11:** that `cwd()` under `agency test` is `packages/agency-lang`, and that `setEnv` in a test node runs before the bridge first loads the package.
