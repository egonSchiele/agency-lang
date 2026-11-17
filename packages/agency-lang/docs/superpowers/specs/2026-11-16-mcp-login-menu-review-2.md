# Second review: Logging in to MCP servers from the agent's `/mcp` menu

- **Spec:** `docs/superpowers/specs/2026-11-16-mcp-login-menu.md`, as revised after the first review
- **First review:** `docs/superpowers/specs/2026-11-16-mcp-login-menu-review.md`
- **Date:** 2026-11-16
- **Code read:** `@agency-lang/mcp` 0.0.5 in this worktree, `@modelcontextprotocol/sdk` 1.29.0, and the agent and stdlib files the spec names.

## Verdict

The revision answers all twelve findings of the first review, and the answers match the code. The goals, the screens, and the place the server state lives are settled. I would not change any of them.

Six gaps are left in the package design. Each one is a case where the spec's text and the 0.0.5 code disagree, or where the spec does not say what happens. Findings 1 to 4 can break a goal or lose a login, so the spec should settle them before the plan is written. Findings 5 and 6 are smaller. The rest are one-line notes.

I read the code for every finding. I did not run anything. Finding 2 is reasoned from the SDK source, and I say so there.

## Settle before the plan

### 1. Only one login can run in the whole process, and an abandoned one blocks the next

The spec says "Only one login per server can be in progress. Calling `startLogin` again for the same server cancels the earlier one first."

The callback page listens on one fixed port for every server. The port is 19876 (`packages/mcp/src/callbackServer.ts:7`), and the manager never passes a different one (`mcpManager.ts:35-40`). So two logins for two different servers cannot run at once. The second `startLogin` fails with `EADDRINUSE`.

The menu can leave a login running without meaning to. Here is the sequence:

1. The user picks "Log in" for linear. `startMcpLogin` starts the callback page.
2. The agent asks the `std::openUrl` approval question.
3. The user presses Escape. The REPL cancels the whole slash command (`lib/stdlib/cli.ts:1571-1581`), so `finishMcpLogin` never runs, and nothing calls `cancelLogin`.
4. The callback page stays on port 19876 until the 5 minute timer ends.
5. The user opens `/mcp` again and picks "Log in" for github. It fails with `EADDRINUSE`.

A second "Log in" for linear works, because the same-server rule cancels the first one. A login for any other server fails for up to 5 minutes.

**Change:** say that one login can be in progress per process, and that `startLogin` for any server first cancels whichever login is in progress. Add a package test: start a login for server A, then start one for server B, and check that B returns a URL.

The hook that disconnects every server at the end of the run (`packages/mcp/src/mcp.ts:38-43`) should cancel a login in progress too. A listening web page keeps a Node process alive, so `/exit` during a login could otherwise wait on it. I did not check whether the agent's exit path calls `process.exit`. The plan should check.

### 2. Two tool calls at the moment a login expires can delete a good login

The spec adds `invalidateCredentials('tokens')`, which deletes `<server>.json` when the server rejects a refresh token. That is the right fix for a refresh token that is dead. It has a side effect when two calls refresh at the same time.

The agent runs a model's tool calls concurrently. The SDK refreshes inside each request, with no lock (`client/streamableHttp.js:322`, `client/auth.js:273-286`). Many OAuth servers give out a new refresh token on every refresh and reject the old one. With such a server:

1. The access token expires. The model calls two linear tools at once.
2. Both calls get a 401, and both read the same saved refresh token, R1.
3. Call A refreshes with R1. The server returns a new login with refresh token R2. A saves it. Call A succeeds.
4. Call B refreshes with R1. The server rejects it with `invalid_grant`.
5. The SDK calls `invalidateCredentials('tokens')` (`auth.js:156-158`). The provider deletes `<server>.json`, which now holds the good login from step 3.
6. Call B fails with "needs a new login", and the server's status becomes "needs login". The user has to log in again in the browser.

In 0.0.5 this cannot happen, because a refresh never runs (the bug in "Why the package needs to change", item 6). The spec fixes that bug, so it opens this case.

I reasoned this from the SDK source. I did not reproduce it.

**Change:** say that `invalidateCredentials('tokens')` deletes the saved login only when it is still the login that was rejected. One way: the provider remembers the refresh token it last returned from `tokens()`. In `invalidateCredentials`, it reads the file again. If the refresh token in the file is a different one, another call has saved a newer login, and the provider keeps the file. The SDK's second try then reads the newer login and goes through.

Add a package test: the fake server rotates refresh tokens, two tool calls run at once after the access token expires, both succeed, and `<server>.json` still exists.

### 3. The spec names two places that set "needs login", and the mid-session case goes through a third

"The OAuth provider works without a running callback page" says: "`OAuthConnector.connect()` and the connection `callTool` builds both turn that error into the 'needs login' status."

"A login that expires during a session" describes a different path. The server is connected, and the tool call runs on the connection that already exists. In the code, that is the last line of `McpManager.callTool` (`mcpManager.ts:108`). It does not go through `OAuthConnector.connect()`, and `callTool` builds no new connection. The "needs login" error from `redirectToAuthorization` comes out of `conn.callTool` there. Nothing in the spec's design section catches it on that line.

**Change:** say that `McpManager.callTool` catches the "needs login" error on every path, including a call on an existing connection. Say what it does to the record: the status becomes "needs login", the tools are dropped, and the connection is closed. Package test 5 covers a refresh that works. Add the other half: a tool call on a connected server whose refresh token is rejected fails with the "needs a new login" message, and `serverStates()` then reports "needs login" for it.

One related case. When a refresh fails with a server error or a network error, the SDK does not throw. It moves on to a new login (`auth.js:287-296`), which in this design ends in "needs login" with the saved login still on disk. The "needs login" screen offers only "Log in" and "Back". The user then does a full browser login when a reconnect would have worked. Adding "Reconnect" to that screen costs one menu line, and it also helps a user who ran `npx @agency-lang/mcp auth linear` in another shell.

### 4. "Only `startLogin` starts the callback page" contradicts the mode that `mcp()` keeps

The spec keeps two login modes. In "ask first", used by `mcp()` and `mcpRaw()`, "the package starts it and waits", as in 0.0.5. Then the provider section says "Only `startLogin` starts the callback page."

In 0.0.5, the callback page starts in `provider.prepare()`, before every connect (`oauthConnector.ts:65`). If only `startLogin` starts it, an "ask first" connect opens the browser and then waits on a page that is not running. That breaks three callers the spec says do not change:

- `mcp()` and `mcpRaw()`, and through them `loadMcpTools` and `loadMcpToolsWithStatus` in `std::mcp`.
- The package's own command, `npx @agency-lang/mcp auth <server>`, which calls `OAuthConnector.connect()` directly (`packages/mcp/src/cli.ts:60-67`). `cli.ts` is not in the spec's file list.

The `state` value has the same kind of gap. The spec says the provider "creates its `state` value when it is built." Today the callback page creates its own `state` and rejects any request that carries a different one (`callbackServer.ts:27` and `:56`). If the provider creates one value and the page creates another, every login ends with the 403 error page. The file list gives `callbackServer.ts` only the cancel fix.

**Change:**

1. Say when the callback page starts in "ask first" mode. The simplest rule is that it starts inside `redirectToAuthorization`, when the SDK asks for a login. `startLogin` is then the same step with the wait left to `finishLogin`.
2. Say that the callback page takes its `state` from the provider, and add that to the `callbackServer.ts` line in the file list.
3. Say that each login gets a new `state`. A provider that keeps one value for its whole life would send the same value on "Log in" and on a later "Log in again".
4. Add `cli.ts` to the file list, and add a package test that the 0.0.5 flow through `mcpRaw()` with no saved login still opens a login and connects.

## Smaller findings

### 5. The Escape test cannot run headlessly as written

Agent test 4.5 is "Escape during a login, followed by a second login that works", and the section says the tests "drive the `/mcp` menu headlessly".

The REPL's cancel key is installed only on a terminal. `installCancelKey` returns at once when there is none (`lib/stdlib/cli.ts:1102`). A headless test has no key to press, so the abort signal never fires.

**Change:** split the test. The abort path goes in `lib/stdlib/mcp.test.ts`: call `finishMcpLogin` with a run whose abort signal fires, and check that it calls `cancelLogin` and throws the cancel error. The "second login works" half is package test 8. If a real Escape matters, say that the test needs a pseudo-terminal.

The spec should also say what the user sees after Escape. The REPL cancels the whole slash command and prints "cancelled" (`cli.ts:1586-1594`). The menu does not return to the server list, which differs from "back to the list after an action" in "The `/mcp` menu".

### 6. The spec does not say which servers the list shows

"The status lines come from `mcpServerStates()`. The other lines on a server's screen come from the config." These two sources can disagree. The menu reads the config again each time it opens, and the records were made at startup.

- The user runs `agency mcp add` in another shell during the session. The server is in the config and has no record.
- The user runs `agency mcp remove`. The server has a record, and its tools are still handed to the model, but it is not in the config.

**Change:** pick one. My suggestion: the list shows the servers in the config. A server with no record shows "not connected" with a "Connect" action, which is `reconnectMcpServer`. A record with no config entry is not listed. Or say that servers added or removed during a session need a restart, and that the list shows records only.

## Small notes

- **Package not installed.** The spec covers a package that is too old. It does not say what `connectMcpServers` and `mcpServerStates` return when the package is absent. Today `/mcp` prints "MCP is not installed" (`lib/agents/agency-agent/lib/mcp.agency:75-80`). Say that this line stays and that both functions return an empty list.
- **"tooOld" as a server status.** The package version is one fact about the process, and the spec reports it once per server. Startup and `/mcp` then have to fold those copies back into one line. A function such as `mcpPackageProblem(): string`, which returns the upgrade message or an empty string, would keep `McpServerState.status` at three values. This is a matter of taste, and the spec's version works.
- **Mixed modes.** "`mcp()` and `mcpRaw()` connect in 'ask first'" and "Any later connection to that server uses the recorded mode" disagree when a program calls `connectServer` and then `mcpRaw()` for the same server. Say which one wins. The agent never does this, so one sentence is enough.
- **"Log in again" and the old connection.** Say that when `finishLogin` succeeds on a connected server, it closes the old connection before it stores the new one.
- **Existing package tests use `port: 0`.** `oauthConnector.test.ts:20`, `oauthProvider.test.ts:114`, and `callbackServer.test.ts:6` ask the system for a free port. Once the redirect URL is built from the configured port before anything listens, port 0 gives a URL with port 0 in it. The plan should pick a fixed test port or keep a way to read the bound port back.
- **`docs/dev/agents/user-commands.md`** describes what the user can type at the prompt and does not mention `/mcp`. The new `agent-mcp.md` is the right home for the mechanism. A one-line pointer from `user-commands.md` would help a reader find it.

## What I checked and found correct

- Every handler is consulted, and `cliPolicyHandler` asks the user itself when no rule matches (`stdlib/policy.agency:1532-1564`, installed at `lib/agents/agency-agent/lib/turn.agency:111-121`). The spec is right that an inner `with approve` would not remove the `std::openUrl` question.
- The agent rebuilds its tools on every turn, and `getMcpTools()` is called from that list (`lib/agents/agency-agent/lib/cliTools.agency:64-76`). Tools from a server the user logs in to appear on the next message.
- The SDK line numbers in "Why the package needs to change", items 6 and 7, match version 1.29.0.
- `AGENCY_MCP_PATH` is honoured by both the availability check and the bridge (`lib/stdlib/mcpResolver.ts:23`, `lib/stdlib/mcpBridge.mjs:47`), so the agent tests can point at a fake package.
- `chooseOption` falls back to plain `input()` when stdout is not a terminal (`stdlib/ui/cli.agency:296-311`), so the menu can be driven by scripted answers.
