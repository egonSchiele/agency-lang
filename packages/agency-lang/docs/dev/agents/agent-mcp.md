# MCP servers in `agency agent`

`agency agent` connects to the MCP servers in the agent's `settings.json` and the project's `agency.json`, and gives the model their tools. A server that needs a login (OAuth) is never logged in to at startup. The user logs in from the `/mcp` menu. This doc covers where server state lives, how a login runs, and the rules that keep a login from starting on its own.

How agency-lang finds the optional `@agency-lang/mcp` package is in `docs/dev/stdlib/mcp-package-loading.md`.

## Where server state lives

The package keeps one connection manager per process (`packages/mcp/src/mcpManager.ts`). It holds one record per server:

```ts
{ status: "connected", tools: McpTool[] }
{ status: "needsLogin" }
{ status: "failed", message: string }
```

Nothing in agency-lang keeps a copy. `getMcpTools()` (`lib/agents/agency-agent/lib/mcp.agency`) asks `std::mcp`'s `mcpServerStates()` on every turn, and the agent rebuilds its tool list every turn (`cliTools`). So a login or a log out in `/mcp` changes the tools on the next message.

No Agency global holds the states or the tools. A resumed session replaces every Agency `let` global with the saved one (`docs/dev/agents/agent-sessions.md`, "How a resume works"). A copy in a global would bring back the old process's states, and tools whose connections no longer exist. The test `toolsSurviveARestore` in `tests/mcpMenu.agency` restores a checkpoint taken before a login and checks that the tools are still there.

## The two login modes

Each server has a login mode in the manager:

- **Ask first.** When a connection needs a login, the package starts one and waits up to `authTimeout`. It hands the login URL to `onOAuthRequired`, or opens the browser when there is no callback. `mcp()`, `mcpRaw()`, `loadMcpTools`, `loadMcpToolsWithStatus`, and `npx @agency-lang/mcp auth` use this mode.
- **Never on its own.** When a connection needs a login, it fails at once with `NeedsLoginError`, and the record becomes `needsLogin`.

A server gets "never on its own" the first time one of the 0.0.6 exports (`connectServer`, `startLogin`, `logout`, `disconnectServer`) is called for it. It keeps that mode for the rest of the process, including when `mcpRaw()` is later called for it. The rule covers every connection the manager builds, including the one `callTool` builds when a server has no connection, for example after a log out. The agent uses only the 0.0.6 exports, so nothing in the agent starts a login except the menu.

## Logging in

A login runs in two steps, with ordinary Agency code between them:

1. `startMcpLogin(merged, name)` starts the callback page on port 19876 and returns the login page URL. It ignores a saved login, so "Log in again" works while the old login still works.
2. The menu calls `openUrl(url)`. That raises `std::openUrl`, which the user's policy answers or the user is asked. A rejected or failed open still prints the URL.
3. `finishMcpLogin(name)` waits for the browser to come back to the callback page, saves the new login, connects, and returns the server's state.

The wait in step 3 lasts at most the server's `authTimeout` (default 5 minutes), counted from `finishMcpLogin`, not from `startMcpLogin`. The time between them is the approval question, which can take a long time. When the login fails, times out, or is cancelled, the saved login and any old connection stay as they were.

Escape while the agent waits aborts the run. `_finishMcpLogin` listens on the run's abort signal, cancels the login, and throws the cancel error, so the REPL closes the menu and prints `cancelled`. `_finishMcpLogin` reads the run on its first line, because `currentRun()` throws after a function's first `await`.

Only one login can be in progress in the whole process, because every callback page uses the same port. `startLogin` cancels whatever login is in progress, for any server. That also clears a login the user abandoned, for example by pressing Escape at the approval question.

## A login that expires during a session

When an access token expires, the SDK refreshes it with the saved refresh token, and the tool call goes through. The provider builds its redirect URL from the port, so the refresh never needs a running callback page.

Several tool calls can find the access token expired at the same moment, and the SDK refreshes inside each call. Many servers give out a new refresh token on every refresh and refuse the old one. So the connector sends a server's refresh requests one at a time (`oneRefreshAtATime` in `oauthConnector.ts`), and each one uses the newest refresh token. The SDK saves a refresh's new token only after the response comes back, so the connector also remembers the last change it saw, in case the file has not caught up yet.

When the server rejects the refresh token, the SDK calls `invalidateCredentials('tokens')`. The provider deletes the saved login only when the file still holds the token the server rejected. A `fetch` wrapper on the transport (`watchingRefreshes`) records that token, because the SDK does not pass it. Without this check, a rejected old token could delete a login another call had just saved.

A call whose login cannot be refreshed fails with `MCP server "<name>" needs a new login.`, and the record becomes `needsLogin`. The call never opens a browser.

## Log out

`logoutMcpServer(name)` raises `mcp::logout` before it deletes the saved login. Every function can be handed to a model as a tool, so deleting a credential needs an interrupt. The user picks "Log out" in the menu and then answers the approval question, so they are asked twice. A policy rule that approves `mcp::logout` skips the second question. The menu does not wrap the call in `with approve`, because the agent's `cliPolicyHandler` asks the user when no rule matches, and every handler is consulted.

Log out keeps `<server>.client.json`, the registration, so the next login does not register again.

## The menu

The `/mcp` list shows the servers in the config, which the menu reads each time it opens. A server's status comes from `mcpServerStates()`, matched by name. A server in the config with no record shows as "not connected" and offers "Connect". A record whose server is no longer in the config is not listed. Its connection stays until the agent restarts.

The actions for each kind of row are one table, `ACTIONS` in `lib/mcpMenu.agency`, and `runAction` is the one place an action key becomes a call.

## The version check

The agent needs `@agency-lang/mcp` 0.0.6 or newer. `mcpPackageProblem()` returns the upgrade message for an older one, and an empty string otherwise, including when the package is not installed. With an old package, startup connects no servers and prints the message, and `/mcp` prints it too. The other functions return an empty list or a failure.

## Interrupts

- `openUrl` raises `std::openUrl`, and `logoutMcpServer` raises `mcp::logout`. Both are answered by the agent's policy handler like any other interrupt.
- Each MCP tool call raises `mcp::call`, because `std::mcp` gates every tool it hands out.
- Starting, finishing, and cancelling a login raise nothing. A login only finishes when a person completes it in their browser.
- Connecting, reconnecting, and starting a login take the server config as an argument and raise nothing. `docs/dev/security/roadmap.md` lists this as a gap.
- Nothing here is saved in a checkpoint. Server states live in the package, and handlers are not skipped on any path, since no step here resumes from a checkpoint.

## Files

| File | What it holds |
|---|---|
| `packages/mcp/src/mcpManager.ts` | The per-server records, the login modes, the one login in progress, log out. |
| `packages/mcp/src/oauthProvider.ts` | The redirect URL, `state`, the "needs login" error, `invalidateCredentials`. |
| `packages/mcp/src/oauthConnector.ts` | Connect, the two-step login, and the fetch that records a rejected refresh token. |
| `packages/mcp/src/callbackServer.ts` | The local page the browser returns to, its timeout, and cancel. |
| `packages/mcp/src/mcp.ts` | The 0.0.6 exports. |
| `lib/stdlib/mcp.ts`, `stdlib/mcp.agency` | The `std::mcp` functions, the gating of tools, the version check, and `mcp::logout`. |
| `lib/stdlib/mcpVersion.ts` | The minimum package version. |
| `lib/agents/agency-agent/lib/mcp.agency` | Startup and `getMcpTools`. |
| `lib/agents/agency-agent/lib/mcpMenu.agency` | The `/mcp` menu. |
| `lib/agents/agency-agent/tests/mcpMenu.agency` | The menu tests, against `tests/fakeMcpPackage.mjs`. |
