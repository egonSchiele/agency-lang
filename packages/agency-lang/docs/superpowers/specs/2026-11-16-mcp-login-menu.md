# Logging in to MCP servers from the agent's `/mcp` menu

- **Date:** 2026-11-16
- **Status:** Draft, revised after two reviews (`2026-11-16-mcp-login-menu-review.md` and `2026-11-16-mcp-login-menu-review-2.md`)
- **Branch:** `adit/mcp-login-menu`
- **Packages changed:** `@agency-lang/mcp` (new release, 0.0.6) and `agency-lang`

## Summary

When `agency agent` starts, it connects to every MCP server it can reach without a login. A server that needs a login it doesn't have yet gets the status "needs login". The agent prints one line about it and carries on. The user logs in later, from a new `/mcp` menu. The menu lists the servers, and lets the user pick one to log in to, log out of, reconnect, or see the tools of. A server the user logs in to becomes usable on their next message, with no restart.

## Background

### How the agent connects to MCP servers today

MCP support lives in a separate npm package, `@agency-lang/mcp`, which agency-lang does not depend on. agency-lang reaches it through one file, `lib/stdlib/mcpBridge.mjs`. The stdlib module `std::mcp` wraps the bridge, and the agent uses `std::mcp`.

At startup, `main()` calls `maybeLoadMcp` (`lib/agents/agency-agent/agent.agency:150`). It reads the configured servers and calls `loadMcpToolsWithStatus`, which connects to each server and collects its tools. Each server ends up "connected" or "unavailable". The `/mcp` command (`lib/agents/agency-agent/lib/repl.agency:322`) prints that status and nothing else.

A server that uses OAuth has `"auth": "oauth"` in its config. Here is the entry `agency mcp add linear --url https://mcp.linear.app/mcp --oauth --global` writes:

```json
{
  "mcpServers": {
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "auth": "oauth" }
  }
}
```

The package saves two files per OAuth server in `~/.agency/tokens/`:

- `<server>.client.json` holds agency's registration with the server.
- `<server>.json` holds the login: an access token and a refresh token.

With a saved login, connecting needs nothing from the user.

### What goes wrong without a saved login

Connecting to an OAuth server with no saved login starts a login. The package registers agency with the server, builds the login page URL, and starts a small local web page on port 19876. The browser returns to that page after the login. The package waits up to 5 minutes for it.

The package opens the browser only when the caller passes no login callback. The agent passes one, `onMcpOAuth` (`lib/agents/agency-agent/lib/mcp.agency:44`), which prints a message and does not open the browser. So nothing opens the login page. Startup sits waiting for 5 minutes, the wait fails with "OAuth callback timed out", and `/mcp` shows the server as "unavailable" with no reason.

Opening the browser in that callback would make the login work, but it would still happen at startup, before the user has asked for anything. The user should choose when to log in.

### Why the package needs to change

Version 0.0.5 of the package has no way to do what this spec needs:

1. **It cannot connect without starting a login.** A server with no saved login always starts one and waits.
2. **Its login is one long call.** The call that connects also opens the login and waits for it. The only place the agent's code runs in between is the login callback, which the package calls from TypeScript. This spec opens the browser with `openUrl` from ordinary Agency code instead, so its `std::openUrl` approval question works like every other one.
3. **It has no log out function.** Only the package's own command line can remove a login, with `npx @agency-lang/mcp auth --revoke <server>`.
4. **Its config and login callback are fixed by the first call.** The package keeps one connection manager per process (`packages/mcp/src/mcp.ts`, `getManager`). A later call's config and callback are ignored with a warning.
5. **Cancelling a login hangs.** The login callback gets a `cancel()` function. `cancel()` shuts down the local web page, but the code waiting for that page never finishes (`packages/mcp/src/callbackServer.ts`, `stop()`). The connection then waits forever.
6. **A login that expires mid-session breaks every call.** After a connect, the provider forgets its redirect URL (`oauthProvider.ts`, `cleanup()`). When the access token expires, the SDK reads that URL before it tries the refresh token (`@modelcontextprotocol/sdk`, `client/auth.js:260`). The read throws "OAuth flow for linear not started", so the refresh never runs. Every call to that server fails until the agent restarts.
7. **A rejected refresh token is never cleared.** When the server rejects a refresh token, the SDK calls `provider.invalidateCredentials('tokens')` and tries once more (`auth.js:153-158`). The provider has no `invalidateCredentials`, so the second try sends the same token and fails the same way.

## Goals

1. Startup never starts a login, never opens a browser, and never waits on a login.
2. `/mcp` shows every configured server with its status, and the reason when it failed.
3. From `/mcp`, the user can log in to a server, log out of it, reconnect it, and list its tools.
4. A server the user logs in to or reconnects is usable on the next message, with no restart.
5. Opening the login page goes through the `std::openUrl` approval question, so the user's policy still applies.
6. Nothing in the agent starts a login except "Log in" and "Log in again" in the menu. That includes tool calls.

## Out of scope

- Adding or removing a server from inside the agent. `agency mcp add` and `agency mcp remove` cover this from the shell.
- Turning a server off without removing it. Claude Code has "Disable". It needs a new per-server setting, and the July spec on branch `agent-mcp-add-design` left it out for the same reason.
- Showing the server's protocol version and capabilities. Claude Code shows them, but they don't help the user decide anything.
- Noticing that a server needs a login when its config lacks `"auth": "oauth"`. Such a server fails with an HTTP 401 error. With this spec, the reason shows in `/mcp`.
- Changing what `loadMcpTools` and `loadMcpToolsWithStatus` in `std::mcp` do for Agency programs.
- Connecting servers in the background so that a slow server does not delay startup.

## What the user sees

### At startup

The agent connects the servers it can. For each server that needs a login, it prints one line:

```
MCP: linear needs you to log in. Type /mcp to log in.
```

For each server that failed, it prints the reason:

```
MCP: github failed to connect: connect ECONNREFUSED 127.0.0.1:3000
```

Connected servers print nothing.

### The server list

```
/mcp

MCP servers
❯ linear   ! needs login
  github   ✔ connected · 12 tools
  files    ✘ failed
```

The list shows the servers in the config, which the menu reads each time it opens. Escape at the list leaves the menu. Choosing a server opens its screen. Escape on a server's screen goes back to the list.

A server that was added to the config after the agent started has no connection yet. It shows as `○ not connected`, and its screen offers "Connect" and "Back". "Connect" does what "Reconnect" does. A server that was removed from the config after the agent started is not listed. Opening `/mcp` disconnects it, so the model stops getting its tools. Until then, or until the agent restarts, its tools stay.

### A server that needs a login

```
linear

Status:  ! needs login
URL:     https://mcp.linear.app/mcp
Config:  ~/.agency-agent/settings.json (global)

❯ 1. Log in
  2. Reconnect
  3. Back
```

"Reconnect" tries the saved login again without opening a browser. It helps when the login was made somewhere else, for example with `npx @agency-lang/mcp auth linear` in another terminal, or when the server's login service had a temporary error.

When the user picks "Log in", the agent asks the usual `std::openUrl` approval question, unless the user's policy already answers it:

```
Are you sure you want to open this URL in the browser?
url: https://mcp.linear.app/authorize?...
❯ approve
  always approve when host = mcp.linear.app
  reject
```

Then the agent waits:

```
Opening the linear login page in your browser.
If it doesn't open, visit: https://mcp.linear.app/authorize?...
Waiting for you to finish logging in. Press Escape to cancel.
```

When the login finishes, the agent connects and prints:

```
✔ linear connected · 70 tools. You can use them from your next message.
```

If the login fails or times out, the agent prints the reason and goes back to the server list. The server's status does not change.

Escape while the agent waits cancels the login. Escape during a slash command stops the whole command, so the menu closes, and the REPL prints `cancelled` as it does for any command the user stops. The server's status does not change.

### A connected server

```
linear

Status:  ✔ connected · 70 tools
URL:     https://mcp.linear.app/mcp
Config:  ~/.agency-agent/settings.json (global)

❯ 1. View tools
  2. Log in again
  3. Log out
  4. Reconnect
  5. Back
```

- **View tools** lists each tool's name and the first line of its description.
- **Log in again** runs the same steps as "Log in", and replaces the saved login when it finishes. If it is cancelled or fails, the old login stays, and the server stays connected.
- **Log out** deletes the saved login, disconnects, and removes the server's tools from the session. The status becomes "needs login".
- **Reconnect** disconnects and connects again with the saved login. It never starts a login.

A server that does not use OAuth shows only "View tools", "Reconnect", and "Back".

### A failed server

```
files

Status:  ✘ failed: spawn npx ENOENT
Command: npx -y @modelcontextprotocol/server-filesystem /tmp
Config:  agency.json (project)

❯ 1. Reconnect
  2. Back
```

### A login that expires during a session

When a server's access token expires, the next tool call refreshes it with the saved refresh token, and the call goes through. If the server rejects the refresh token, the call fails, and the model gets this message:

```
MCP server "linear" needs a new login.
```

The message comes from the package, so it does not name the agent's `/mcp` command. The server's status becomes "needs login", so `/mcp` shows it. The call never opens a browser and never waits.

### When the installed package is too old

If the installed `@agency-lang/mcp` is older than 0.0.6, startup connects no MCP servers and prints:

```
MCP: @agency-lang/mcp 0.0.5 is too old. Run: npm install -g @agency-lang/mcp@latest
```

`/mcp` prints the same line. This drops servers that work on 0.0.5 today, such as stdio servers, until the user upgrades. That is intended. It keeps one code path, and the fix is one command.

When the package is not installed at all, nothing changes from today. Startup prints nothing, and `/mcp` prints `MCP is not installed. Run: npm install @agency-lang/mcp`.

## Design

### 1. The package: `@agency-lang/mcp` 0.0.6

#### Where server state lives

The connection manager keeps one record per server: its status, a failure message, and its tools. The new exports read and write these records. Nothing in agency-lang keeps its own copy. That matters for `agency agent --resume`, which replaces every Agency `let` global with the saved one (`docs/dev/agents/agent-sessions.md`, "How a resume works"). A copy in an Agency global would bring back the old process's states and tools.

The manager is still one per process. Each new export takes the server's config on every call, and the manager stores the config it is given. `mcp()` and `mcpRaw()` keep their current behavior. When one of them is called without a config, it leaves the stored config alone.

#### Connections never start a login on their own

Each server has a login mode:

- **Ask first**, the 0.0.5 behavior. When a login is needed, the package starts it and waits.
- **Never on its own.** When a login is needed, the connection fails at once with "needs login".

Every new export connects in "never on its own", and records that mode for the server. Any later connection to that server uses the recorded mode. That includes the connection `McpManager.callTool` builds when it has none (`mcpManager.ts:96-104`), so a tool call after a log out fails with "needs login" instead of starting the 0.0.5 login.

`mcp()` and `mcpRaw()` connect in "ask first", as today, for a server with no recorded mode. They do not change a recorded mode. So once a new export has been called for a server, that server never starts a login on its own for the rest of the process.

`McpManager.callTool` catches the "needs login" error on every path. That includes a call on a connection that already exists (`mcpManager.ts:108`), which is the path a login that expires during a session takes. When it catches the error, it sets the server's status to "needs login", drops the server's tools, closes the connection, and throws `MCP server "<name>" needs a new login.`

#### The OAuth provider works without a running callback page

The SDK reads `provider.redirectUrl` before every refresh and login (`auth.js:260`), and reads `provider.state()` before it builds a login URL (`auth.js:299`). In 0.0.5, both throw unless the callback page is running.

In 0.0.6, the provider builds its redirect URL from the configured port, `http://127.0.0.1:19876/oauth/callback` by default, without starting anything. A connect no longer starts the callback page. The page starts only when a login starts:

- In "ask first" mode, it starts inside `redirectToAuthorization`, at the moment the SDK asks for a login. So `mcp()`, `mcpRaw()`, and `npx @agency-lang/mcp auth <server>` behave as they do in 0.0.5.
- In "never on its own" mode, it starts in `startLogin`.

The provider creates a new `state` value each time the SDK calls `state()`, and gives that value to the callback page when the page starts. Today the page creates its own `state` and refuses a request that carries any other (`callbackServer.ts:27` and `:56`). The page now takes the value in its options. Each login gets a new value.

This has three effects:

1. `connectServer` can connect many OAuth servers at once. Today, two servers that both need a login would both try to bind port 19876, and the second would fail with `EADDRINUSE`.
2. The redirect URL is the same in every call. The registration in `<server>.client.json` lists it, so the URL must not change between `connectServer` and `startLogin`.
3. A refresh during a session works, because `redirectUrl` no longer throws.

In "never on its own" mode, `redirectToAuthorization` throws a "needs login" error. `OAuthConnector.connect()` and the connection `callTool` builds both turn that error into the "needs login" status.

The provider gets an `invalidateCredentials(scope)` method:

- `'tokens'` deletes `<server>.json`.
- `'all'` also deletes `<server>.client.json`.

With it, a rejected refresh token deletes the saved login, and the SDK's second try ends in `redirectToAuthorization`, which returns "needs login".

`'tokens'` deletes the saved login only when it is still the login that was rejected. The agent runs a model's tool calls at the same time, and many servers give out a new refresh token on every refresh and refuse the old one. Two calls that refresh at once would otherwise go like this: the first call saves a new login, the server refuses the second call's old refresh token, and the delete removes the login the first call saved. So the provider records which refresh token the server refused. The SDK does not pass that token to `invalidateCredentials`, and the last token `tokens()` returned is no guide, because the transport also calls `tokens()` to build every request's header (`client/streamableHttp.js:58-61`). The SDK does send every token request through the `fetch` in the transport's options (`streamableHttp.js:31-32` and `:322-327`). `OAuthConnector` gives its transports a `fetch` that watches for a refresh request the server answers with `invalid_grant`, and tells the provider that request's refresh token. In `invalidateCredentials('tokens')` the provider reads the file again. If the file holds a different refresh token from the refused one, another call has saved a newer login, and the provider keeps the file. The SDK's second try then reads the newer login.

#### The new exports

**`connectServer(serverName, { config })`** connects one server and lists its tools. It never starts a login. It returns the server's record:

```ts
{ status: "connected", tools: McpTool[], callTool }
{ status: "needsLogin" }
{ status: "failed", message: string }
```

The provider may register agency with the server before it finds out a login is needed. That registration is saved in `<server>.client.json` and reused by the later login.

**`serverStates()`** returns every server's record, without connecting anything.

**`startLogin(serverName, { config })`** starts a login and returns the login page URL. It does not wait for the login.

```ts
{ status: "started", authUrl: string }
{ status: "failed", message: string }
```

It ignores any saved login. While a login is in progress, the provider's `tokens()` returns nothing, so the SDK goes straight to a new login even when the old one still works. `startLogin` starts the callback page and keeps it running until `finishLogin` or `cancelLogin`.

Only one login can be in progress in the whole process, because every server's callback page uses the same port. `startLogin` first cancels whichever login is in progress, for any server. This also clears a login that was abandoned. For example, the user presses Escape at the `std::openUrl` question, so the menu closes before anything calls `finishLogin` or `cancelLogin`.

**`finishLogin(serverName)`** waits for the browser to return to the callback page, saves the new login over the old one, connects, and lists the tools. On a server that is connected, it closes the old connection before it stores the new one. It returns the same records as `connectServer`. With no login in progress, it returns `{ status: "failed", message: "no login in progress for linear" }`.

It waits at most the server's `authTimeout`, which defaults to 5 minutes, counted from the call to `finishLogin`. The time between `startLogin` and `finishLogin` is not counted. That time is the `std::openUrl` question, and a question can wait a long time. A program started with `spawn` holds the question until a person answers it with `agency attach` (`docs/dev/runtime/spawn.md`), which can be hours later. The login must still be there when they do. The callback page also has a longer limit, 30 minutes from `startLogin`. It stops then, or at the next `startLogin`, at `cancelLogin`, or when the run ends, whichever comes first. Without that limit, a login nobody finished would hold port 19876 for as long as the process runs, and every other agency process would fail to start a login. A `finishLogin` after the page stopped fails with `The login page closed after 30 minutes. Start the login again.` A `startLogin` that finds the port taken fails with `another login is in progress (port 19876 is in use). Finish or cancel it, then try again.`

**`cancelLogin(serverName)`** stops a login in progress and stops its callback page. A `finishLogin` that is waiting returns `{ status: "failed", message: "login cancelled" }`. With no login in progress, it does nothing.

When a login ends without finishing, by timeout, cancel, or failure, the saved login is left as it was. A server that was connected stays connected.

**`logout(serverName)`** disconnects the server and deletes `<server>.json`. It keeps `<server>.client.json`, so the next login does not register again. The server's status becomes "needs login". It returns `{ status: "loggedOut" }` or `{ status: "failed", message }`.

**`disconnectServer(serverName)`** closes the connection and drops the server's tools. Reconnecting is `disconnectServer` followed by `connectServer`.

The hook that disconnects every server when the run ends (`packages/mcp/src/mcp.ts:38-43`) also cancels a login in progress. A callback page that is still listening would keep the process from exiting.

#### The cancel fix

`CallbackServer` attaches a handler to its code promise when it creates it. `stop()` then rejects the promise with "OAuth flow cancelled" when no code has arrived. A rejection that nobody waits on is dropped instead of ending the process.

This matters because `stop()` also runs after every connect that needed no login (`oauthConnector.ts:73`). Nothing waits on the promise there. Node ends the process on a rejection that has no handler, and agency-lang installs no `unhandledRejection` handler.

### 2. The bridge and `std::mcp`

`lib/stdlib/mcpBridge.mjs` gets one pass-through per new export. `mcpBridge.d.mts` pins their shapes, and `mcpBridge.contract.test.ts` checks them against the built package.

`std::mcp` gets one new type and eight functions. The functions turn the package's tools into gated Agency functions, the same way `loadMcpToolsWithStatus` does today. So every call to an MCP tool still raises `mcp::call`.

```ts
export type McpServerState = {
  name: string;
  status: "connected" | "needsLogin" | "failed";
  message: string;
  tools: any[]
}
```

`message` is empty unless the status is "failed". `tools` is empty unless the status is "connected".

| Function | What it does | Capabilities |
|---|---|---|
| `mcpPackageProblem()` | Returns the upgrade message when the installed package is older than 0.0.6. Returns an empty string otherwise, including when the package is not installed. | none |
| `connectMcpServers(merged)` | Connects every server in `merged` without starting a login. Returns one `McpServerState` per server. | `fileRead, fileWrite, network, subprocess` |
| `mcpServerStates()` | Returns the package's current record for each server, as `McpServerState`. Connects nothing. | none |
| `startMcpLogin(merged, name)` | Starts a login. Returns the login page URL as a `Result<string>`. | `fileRead, fileWrite, network` |
| `finishMcpLogin(name)` | Waits for the login to finish, then connects. Returns an `McpServerState`. | `fileRead, fileWrite, network` |
| `cancelMcpLogin(name)` | Stops a login in progress. | `network` |
| `logoutMcpServer(name)` | Deletes the saved login and disconnects. Raises `mcp::logout`. Returns a `Result`. | `fileWrite, network` |
| `reconnectMcpServer(merged, name)` | Disconnects and connects again without starting a login. Returns an `McpServerState`. | `fileRead, fileWrite, network, subprocess` |

The plan confirms each tag against `--check-capabilities`.

`finishMcpLogin` listens on the run's abort signal, read with `ctx.getAbortSignal(stack)` as `openUrlImpl` does (`lib/stdlib/system.ts:59`). When the user presses Escape, it calls `cancelLogin` and throws `leafCancel(...)` from `lib/stdlib/abortable.ts`. The agent's REPL already aborts the run on Escape while a slash command runs, as it does for a `!command` (`docs/dev/agents/user-commands.md`).

The version check is `mcpPackageProblem()`. For version 0.0.5 it returns `@agency-lang/mcp 0.0.5 is too old. Run: npm install -g @agency-lang/mcp@latest`. The package's version is one fact about the process, so it is one function and not a status on every server. `mcpServerStates()` takes no config, so it could not name the servers to mark. When the package is too old or not installed, `connectMcpServers` and `mcpServerStates` return an empty list, and the other functions return a failure. The agent calls `mcpPackageProblem()` at startup and at the top of `/mcp`, and prints the message after `MCP: `.

#### The new `mcp::logout` effect

`logoutMcpServer` deletes a saved credential. Every function in Agency can be handed to a model as a tool, so this deletion raises an interrupt, like other stdlib functions that delete or change user data.

```ts
@always(server)
effect mcp::logout {
  server: string
}
```

Logging in needs no new effect. The login only finishes when the user completes it in their own browser, and opening the browser already raises `std::openUrl`.

### 3. The agent

#### Startup

`maybeLoadMcp` calls `connectMcpServers` in place of `loadMcpToolsWithStatus`, and prints the startup lines shown above. `onMcpOAuth` is deleted. The module's two globals, `mcpTools` and `mcpServerStatus`, are deleted.

`getMcpTools()` calls `mcpServerStates()` and returns the tools of every connected server. The agent rebuilds its tool list on every turn (`cliTools`, `lib/agents/agency-agent/lib/cliTools.agency:64`). So when the menu changes a server, its tools change on the next message. After `--resume`, the tools come from the new process's connections.

#### The `/mcp` menu

The menu goes in its own file, `lib/agents/agency-agent/lib/mcpMenu.agency`. `mcp.agency` keeps startup and `getMcpTools`. The menu uses `chooseOption` from `std::ui/cli` with `allowCancel: true`, as the `/settings` screen does (`lib/agents/agency-agent/lib/capabilitiesUi.agency:177`).

The menu loops: the server list, then a server's screen, then back to the list after an action.

The list of servers comes from the config. Each server's status comes from `mcpServerStates()`, matched by name. A server in the config with no state is "not connected". A state with no server in the config is not shown. The other lines on a server's screen come from the config:

- The menu reads the global config with `getMcpServers(loadSettings())` and the project config with `readProjectMcpConfig(cwd())`.
- `Config` says "project" with the `agency.json` path when the name is in the project config, since the project wins in the merge. Otherwise it says "global" with the `settings.json` path.
- `URL` comes from an HTTP server's `url`. `Command` comes from a stdio server's `command` and `args`.

#### Logging in

"Log in" and "Log in again" run these steps:

1. `startMcpLogin(merged, name)` returns the URL.
2. `openUrl(url)` opens the browser. It raises `std::openUrl`, which the agent's policy handler answers from a rule or by asking the user. When the open is rejected or fails, the agent still prints the URL, so the user can open it themselves.
3. The agent prints the waiting message.
4. `finishMcpLogin(name)` waits, then returns the server's new state.

Step 2 is Agency code that runs between two calls into the package, so its interrupt is raised the same way as any other.

The menu does not wrap these calls in `with approve`. The agent runs every turn and slash command under `cliPolicyHandler` (`lib/agents/agency-agent/lib/turn.agency:113`), which asks the user when no rule matches. Every handler is consulted, so an inner `with approve` would not save the user that question.

"Log out" calls `logoutMcpServer(name)`, which raises `mcp::logout` and is answered the same way.

## Approvals and safety

- **Opening the browser** raises `std::openUrl`. The user's policy answers it, or the user is asked.
- **Logging out** raises the new `mcp::logout`, answered the same way. The user picks "Log out" and then approves it, so they are asked twice. A policy rule can approve `mcp::logout` to skip the second question.
- **Nothing else starts a login.** Every connection the new exports make, including the one a tool call builds, fails with "needs login" instead of starting one.
- **The model cannot finish a login.** The menu belongs to the agent's harness and is never in the model's tool list. If a program hands `startMcpLogin` to a model, the login still needs a person to finish it in their browser.
- **Calling MCP tools** still raises `mcp::call` on every call, because the new functions gate tools the same way the old ones do.
- **No config file is written.** The menu changes only connections and saved logins.
- **A server config passed as an argument raises no interrupt.** `connectMcpServers`, `reconnectMcpServer`, and `startMcpLogin` take the config as a value. A program that hands one of them to a model lets the model choose the `command` a stdio server runs. `loadMcpToolsWithStatus` already has this shape. This spec adds three more functions with it, and adds the gap to `docs/dev/security/roadmap.md`.

## Files

**`packages/mcp`:**

- `src/mcp.ts`: the new exports, and the manager taking config on every call.
- `src/mcpManager.ts`: the per-server records, the login mode, logins in progress, log out, disconnect, and the mode in `callTool`'s reconnect.
- `src/oauthProvider.ts`: the redirect URL and `state` without a running page, the "needs login" error, `invalidateCredentials`, and `tokens()` returning nothing during a login.
- `src/oauthConnector.ts`: the login split into start and finish.
- `src/callbackServer.ts`: the cancel fix, the `state` value taken from its options, and a timer that starts when the wait starts.
- `src/tokenStore.ts`: delete a saved login, with or without the registration.
- `src/cli.ts`: no change expected. `auth <server>` calls `OAuthConnector.connect()` in "ask first" mode, and a test checks that it still logs in.
- `package.json`: version 0.0.6.

**`packages/agency-lang`:**

- `lib/stdlib/mcpBridge.mjs`, `mcpBridge.d.mts`, `mcpBridge.contract.test.ts`: the new pass-throughs.
- `lib/stdlib/mcp.ts`: the TypeScript behind the new `std::mcp` functions, the abort signal in `finishMcpLogin`, and the version check.
- `stdlib/mcp.agency`: `McpServerState`, the eight functions with docstrings and capabilities, and the `mcp::logout` effect.
- `lib/agents/agency-agent/lib/mcp.agency`: startup and `getMcpTools`, with no globals.
- `lib/agents/agency-agent/lib/mcpMenu.agency`: new, the `/mcp` menu.
- `lib/agents/agency-agent/lib/repl.agency`: `/mcp` calls the menu.
- `docs/dev/agents/agent-mcp.md`: new dev doc on how the agent connects, logs in, and where server state lives, with a line in `CLAUDE.md`.
- `docs/dev/security/roadmap.md`: the config-as-argument gap.
- `docs/dev/agents/user-commands.md`: one line that points to `agent-mcp.md` for `/mcp`.

## Testing

**Package unit tests (`packages/mcp/tests/`):**

1. `connectServer` on an OAuth server with no saved login returns `needsLogin`. No browser opens, no callback runs, and the call returns without waiting.
2. Two OAuth servers that both need a login, connected at the same time, both return `needsLogin`. Neither fails with `EADDRINUSE`.
3. `connectServer` with a saved login connects. No unhandled rejection is raised. The package has no fake OAuth server today, so the tests add one, `tests/fakeOAuthServer.ts`: a local HTTP server that registers a client, gives out and refreshes logins, and serves MCP only to a request with a current access token.
4. A saved login whose refresh token the fake server rejects returns `needsLogin`, and `<server>.json` is deleted.
5. A tool call after the access token expires refreshes it and succeeds.
6. `startLogin` returns a URL, and `finishLogin` connects after the test sends a request with a code to the callback page.
7. "Log in again" with a working login: `startLogin` returns a URL. After `cancelLogin`, the old login is still saved, and the server is still connected.
8. `cancelLogin` makes a waiting `finishLogin` return "login cancelled" right away, and a new `startLogin` can bind port 19876 again.
9. `finishLogin` with no login in progress returns the "no login in progress" failure.
10. `logout` deletes `<server>.json` and keeps `<server>.client.json`. A tool call afterwards fails with "needs login" and starts no login.
11. `CallbackServer.stop()` rejects a pending `waitForCode()`. This test fails on 0.0.5.
12. A later call with a changed config uses the new config. A `mcpRaw()` call without a config leaves it alone.
13. `startLogin` for server A, then `startLogin` for server B. B returns a URL, and A's login is cancelled.
14. The fake server gives out a new refresh token on every refresh. Two tool calls run at once after the access token expires. Both succeed, and `<server>.json` still exists.
15. A tool call on a connected server whose refresh token is rejected fails with `MCP server "<name>" needs a new login.` Afterwards `serverStates()` reports "needs login" for it, with no tools.
16. `mcpRaw()` on an OAuth server with no saved login and no recorded mode still starts a login, waits, and connects, as in 0.0.5. The callback page accepts the `state` in the login URL.
17. `finishLogin` called later than `authTimeout` after `startLogin` still waits. It times out `authTimeout` after its own call.
18. Two logins in a row for one server use different `state` values.

The existing package tests ask for port 0, which lets the system pick a free port. The redirect URL is now built before anything listens, so port 0 would put a 0 in the URL. These tests pick a free port first and pass that number.

**agency-lang:**

1. `mcpBridge.contract.test.ts` checks the new exports against the built package.
2. `lib/stdlib/mcp.test.ts` mocks the bridge. It checks each `std::mcp` function's states, the gating of tools, and `mcpPackageProblem()` for a package that reports 0.0.5. It also checks the cancel path: when the run's abort signal fires while `finishMcpLogin` waits, the function calls `cancelLogin` and throws the cancel error. The REPL's Escape key exists only on a terminal (`lib/stdlib/cli.ts:1102`), so a headless agent test cannot press it.
3. An agency test checks that `logoutMcpServer` raises `mcp::logout`, and that a rejection leaves the login in place.
4. Agent tests call the menu's actions directly. The menu keeps each action (log in, log out, reconnect) in a function of its own, and the picker is a thin loop over `chooseOption`, so the tests need no scripted input. Every test rejects `std::openUrl`, because an approval would open a real browser. They point `AGENCY_MCP_PATH` at a fake package that returns fixed states, and check:
   1. the startup lines,
   2. a login that connects and adds tools to `getMcpTools()`,
   3. a log out that removes them,
   4. a rejected `std::openUrl` that still prints the URL,
   5. a login that is started and never finished, followed by a login to another server that works,
   6. a server that is in the config and has no state, which shows as "not connected" and connects with "Connect",
   7. and a `restore()` to a checkpoint taken before a login, after which `getMcpTools()` still has the server's tools. A resume replaces Agency globals the same way a restore does, so this covers a resumed session without starting a second process.

Run only the test files these changes touch, and save the output to a file. Do not run the whole agency test suite locally.

## Release order

1. Publish `@agency-lang/mcp` 0.0.6.
2. Merge the agency-lang change. Until the user upgrades the package, the agent connects no MCP servers and prints the upgrade line.

The owner publishes packages, so step 1 is a handoff.

## Open question

The user guide, `docs/site/guide/mcp.md`, says the package opens the browser on the first connection, and it shows `npx @agency-lang/mcp auth` for logins. The guide needs a section on the agent's `/mcp` menu. Guide pages are hand-written, so this needs the owner's go-ahead.
