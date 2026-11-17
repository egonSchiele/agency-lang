# Review: Logging in to MCP servers from the agent's `/mcp` menu

- **Spec:** `docs/superpowers/specs/2026-11-16-mcp-login-menu.md`
- **Date:** 2026-11-16
- **Package versions read:** `@agency-lang/mcp` 0.0.5 in this worktree, and `@modelcontextprotocol/sdk` 1.29.0 from the workspace's `node_modules/.pnpm`.

## Verdict

The goals are right, and the user-facing design is clear. The background section is accurate. I checked each of its claims against the code, and they hold:

1. The agent passes a login callback, so nothing opens the browser (`packages/mcp/src/oauthProvider.ts:173-191`).
2. Startup then waits for the 5-minute timeout (`callbackServer.ts:85`).
3. `cancel()` stops the timer and the web page but never rejects the promise that `connect()` waits on (`callbackServer.ts:96`, `oauthConnector.ts:83`).
4. The config and the callback are fixed by the first caller (`packages/mcp/src/mcp.ts:22-57`).

The package design has gaps that the plan cannot fill on its own. Findings 1 to 6 change what the package or the agent must do, so the spec should settle them before the plan is written. Findings 7 to 12 are smaller.

## Must settle before the plan

### 1. The cancel fix as written would end the process after a normal connect

The spec says `CallbackServer.stop()` rejects the pending code promise when no code has arrived yet.

`stop()` runs on paths where nobody waits on that promise. `OAuthConnector.connect()` calls `provider.cleanup()` after every connect that needed no login (`oauthConnector.ts:73` and `:77`). `cleanup()` calls `stop()` (`oauthProvider.ts:205`). In that case `redirectToAuthorization` never ran, so nothing ever attached a handler to the code promise. With the fix, every connect that uses a saved login rejects a promise that nobody handles.

Node ends the process on an unhandled rejection by default. agency-lang installs no `unhandledRejection` handler (the only mention is a comment in `lib/runtime/ipc.ts:945`).

The split login adds a second case. The timer starts in `startLogin`, so it can fire before the agent calls `finishLogin`, while the user is still answering the `std::openUrl` question.

**Change:** say that the code promise always has a handler attached when it is created, so a rejection that nobody awaits is dropped. Add a package test: connect with a saved login, then check that no unhandled rejection was raised.

### 2. The "needs login" mode needs more than a change to `redirectToAuthorization`

The spec puts the whole mode in `redirectToAuthorization`, which would throw a "needs login" error.

The SDK reads two provider values before it gets there (`@modelcontextprotocol/sdk/dist/esm/client/auth.js`):

1. `provider.redirectUrl` at line 260, and inside `provider.clientMetadata` when it registers at line 249.
2. `provider.state()` just before it builds the login URL.

Both throw unless the callback server is running (`oauthProvider.ts:89` and `:96`). So `connectServer` must either start the callback server or let the provider answer those two calls without it.

Starting the server is the wrong choice. The port is fixed at 19876 (`callbackServer.ts:7`). Startup connects every server after the first at the same time (`lib/stdlib/mcp.ts:131-137`). Two OAuth servers that both need a login would both try to bind port 19876, and the second would fail with `EADDRINUSE`. The user would see "failed" for a server that only needs a login.

**Change:** say that the provider builds its redirect URL from the configured port without starting a server, and that only `startLogin` starts the callback server. The registration saved in `<server>.client.json` lists that redirect URL, so the URL must stay the same between `connectServer` and `startLogin`. Add a package test with two OAuth servers that both need a login, connected at the same time.

The same change fixes a bug in 0.0.5 that the spec does not mention. After a successful connect, `cleanup()` clears the redirect URL (`oauthProvider.ts:205-211`). When the access token expires mid-session, the next tool call gets a 401. The transport then calls `auth()` (`streamableHttp.js:314-322`), which reads `redirectUrl` at line 260 and throws "OAuth flow for linear not started". The refresh at line 272 never runs. So today, every call to that server fails until the agent restarts. The spec should say what a tool call does when the access token expires mid-session:

1. If the refresh works, the call succeeds.
2. If the refresh fails, the call fails with a message that tells the user to use `/mcp`. It never opens a browser, and it never waits.

### 3. An expired login comes back as "failed", not "needs login"

The spec says a login is needed "when the saved login has expired and cannot be refreshed".

When the server refuses the refresh token, the SDK throws `InvalidGrantError`. `auth()` catches it, calls `provider.invalidateCredentials?.('tokens')`, and tries once more (`auth.js:156-158`). `AgencyOAuthProvider` has no `invalidateCredentials`, so the second try refreshes with the same token, gets the same error, and throws it. `connectServer` would return `{ status: "failed", message: "invalid_grant…" }`.

**Change:** add `invalidateCredentials` to the provider. `'tokens'` deletes `<server>.json`, and `'all'` also deletes `<server>.client.json`. Add a package test: a saved login whose refresh token the fake server rejects returns `needsLogin`.

### 4. "Log in again" on a working login produces no login page

`startLogin` gets the login URL by connecting and catching the redirect. With a saved login that still works, the connect succeeds (`oauthConnector.ts:70-74`) and the SDK never calls `redirectToAuthorization`. So `startLogin` has no URL to return. The spec gives it no result for this case.

**Change:** say that `startLogin` ignores the saved login. During a login in progress, the provider's `tokens()` returns nothing. `finishLogin` writes the new login over the old one. A cancelled or failed "Log in again" then leaves the old login in place, and the server stays connected. Add that to the "Log in again" bullet and to the package tests.

### 5. A resumed session replaces the new server states with old ones

`docs/dev/agents/agent-sessions.md:73-82` says that a restore replaces every Agency `let` global, and that the MCP connections survive because they live in TypeScript. The spec stores each server's state "in the module's state". If that means a `let` global, as `mcpTools` is today (`lib/agents/agency-agent/lib/mcp.agency:25-27`), then `agency agent --resume` throws away what startup found and puts back what the old process had.

Here is an example:

1. In the old session, linear had the status "needs login". The session was saved.
2. The user ran `npx @agency-lang/mcp auth linear` in the shell.
3. The user resumed. Startup connected linear with 70 tools.
4. The restore set linear back to "needs login" with no tools.

The reverse also happens. A server saved as "connected" comes back as "connected" after its login was revoked. The restored tool values are not the new process's tools, either. The package builds them with `new AgencyFunction` (`packages/mcp/src/toolAdapter.ts:45`), not `AgencyFunction.create`, so they are not in the registry that `FunctionRefReviver.revive` reads (`lib/runtime/revivers/functionRefReviver.ts:60-75`).

Today's `mcpTools` global already has this problem. This spec makes it more likely, because the states now change during a session.

**Change:** say where the states live so that a restore cannot replace them. I recommend keeping them out of Agency globals. The package's manager already holds the connections and tools. `std::mcp` can read the states from the manager and build the gated tools when asked. `getMcpTools()` would then call into `std::mcp` on every turn instead of returning a global. Add an agent test that resumes a session and checks `/mcp` against the new process's connections.

### 6. A tool call with no connection can still start the old blocking login

`McpManager.callTool` builds a new connection when it has none (`mcpManager.ts:96-104`). For an OAuth server with no saved login, that runs the 0.0.5 login. The spec deletes `onMcpOAuth`, so there is no callback, and the package opens the browser itself (`oauthProvider.ts:181`) and waits 5 minutes. This skips the `std::openUrl` question. That breaks goals 1 and 5.

After `logout` or `disconnectServer`, the server has no connection, so any call to one of its tools takes this path. The agent rebuilds its tools every turn (`cliTools.agency:64-76`), so the coordinator should not hold an old tool. A program that keeps the tools in a variable can, and so can the restored session in finding 5.

**Change:** say that every connection the new exports make uses the no-login mode. That includes the connection `callTool` builds. A call with no connection to a server that needs a login fails with a "needs login" message. Say also what `mcp()` and `mcpRaw()` do to the config and mode the new exports stored, since all of them share one manager. My suggestion is that a call without a config leaves the stored config alone.

## Smaller findings

### 7. Open question 1 can be answered now: Escape reaches a slash command

The cancel key does reach a slash command that is waiting:

1. `docs/dev/agents/user-commands.md:93-95` says that Escape stops a `!command`. The REPL's cancel key aborts the run, and `_bash` kills the command on that signal. `!command` runs from the same `match` as the slash commands (`repl.agency:339`).
2. `repl.agency:397-398` describes a compaction that the user stops with Escape.

Stdlib TypeScript reads that signal with `ctx.getAbortSignal(stack)`. `openUrlImpl` does this (`lib/stdlib/system.ts:59`). The cancel error comes from `leafCancel` in `lib/stdlib/abortable.ts`.

**Change:** make it a decision instead of an open question. `_finishMcpLogin` listens on the run's abort signal. When the signal fires, it calls `cancelLogin` and throws `leafCancel(...)`. The waiting message says "Press Escape to cancel." Add an agent test that cancels a login and then starts another one. The second login must be able to bind port 19876 again.

### 8. The 5 minutes start at `startLogin`, not at `finishLogin`

The timer starts when the callback server starts (`callbackServer.ts:85`). In the split login, that happens in `startLogin`. So the time the user spends on the `std::openUrl` question counts against the 5 minutes.

**Change:** in the `finishLogin` section, say "at most `authTimeout`, counted from `startLogin`".

### 9. The new `std::mcp` functions need `@capabilities` tags

`loadMcpToolsWithStatus` carries `@capabilities(fileRead, fileWrite, network, subprocess)` (`stdlib/mcp.agency:62`). The spec's table of six functions lists none. CI compiles with `--check-capabilities`, so the build fails without them.

**Change:** list the tags in the table. My reading is:

| Function | Tags |
|---|---|
| `connectMcpServers`, `reconnectMcpServer` | `fileRead, fileWrite, network, subprocess` |
| `startMcpLogin`, `finishMcpLogin` | `fileRead, fileWrite, network` |
| `logoutMcpServer` | `fileWrite, network` |

`network` is on `logoutMcpServer` because it closes a connection.

### 10. Merging before the upgrade turns off servers that work today

The release order says that until the user upgrades, "the agent connects no MCP servers". A user on 0.0.5 with a stdio server or a server that uses a header token has working MCP tools today. After the merge, they lose all of them, including servers that never needed a login.

**Change:** I recommend that when the package is older than 0.0.6, `maybeLoadMcp` loads the servers without `"auth": "oauth"` with today's `loadMcpToolsWithStatus` and no callback. Those servers never start a login, so goal 1 still holds. Only the OAuth servers get the status "tooOld". If you would rather keep one code path, say in the release section that this drop is intended.

### 11. The server screen shows data that `McpServerState` does not hold

The screens show `URL`, `Command`, and `Config: ~/.agency-agent/settings.json (global)`. `McpServerState` has only the name, status, message, and tools. `mergeMcpServers` drops the file each server came from (`lib/stdlib/mcp.ts:55-64`).

**Change:** say where the menu gets these lines. For example, the menu could read `getMcpServers(loadSettings())` and `readProjectMcpConfig(cwd())` separately and report "project" when the name is in the project config, since project wins in the merge.

### 12. The safety section should name the config-as-argument gap

`connectMcpServers(merged)`, `reconnectMcpServer(merged, name)`, and `startMcpLogin(merged, name)` take the server config as a value and raise no interrupt. A program that hands one of them to a model lets the model choose the `command` a stdio server spawns. `loadMcpToolsWithStatus(merged)` has the same shape today (`stdlib/mcp.agency:62-69`), so the gap already exists. This spec adds three more functions with that shape. The safety section says "The model cannot log in on its own", but it does not mention this.

**Change:** add one bullet to "Approvals and safety" that names the gap. Then either point to `docs/dev/security/roadmap.md`, or add the gap there.

## Small notes

- The spec says Escape at the server list leaves the menu. It should also say what Escape does on a server's screen. I assume it goes back to the list.
- The spec has eight package tests. Findings 1 to 4 add four more:
  1. A connect with a saved login raises no unhandled rejection.
  2. Two OAuth servers that need a login connect at the same time.
  3. An expired refresh token returns `needsLogin`.
  4. "Log in again" with a working login returns a URL, and keeps the old login when cancelled.
- The agent tests need two more, from findings 5 and 7: a resumed session, and Escape during a login.
- Open question 2 is correct to ask. `docs/site/guide/mcp.md` is hand-written, and the owner decides whether to change it.
