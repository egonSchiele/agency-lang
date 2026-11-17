# Review: MCP Login Menu Implementation Plan

- **Plan:** `docs/superpowers/plans/2026-11-16-mcp-login-menu.md`
- **Spec:** `docs/superpowers/specs/2026-11-16-mcp-login-menu.md`, as revised after two reviews
- **Date:** 2026-11-16
- **Code read:** `@agency-lang/mcp` 0.0.5 in this worktree, `@modelcontextprotocol/sdk` 1.29.0 (`client/auth.js` and `client/streamableHttp.js`), and the agency-lang files the plan names. I ran nothing.

## Verdict

The plan follows the spec closely. Every screen, message, and rule in the spec has a task and a test. The task order is right: each task produces what the next one consumes. The "Review Focus" list and the closing list of checks done only by reading are useful to whoever builds it.

Four things should change before anyone builds from it. Finding 1 would put PR 2's commits into PR 1. Finding 2 is a hole in the design for two refreshes at once, and the plan's own test for that case is likely to fail on it. Findings 3 and 4 are smaller, but an implementer would hit each one and have to stop. Findings 5 to 9 are notes.

## Fix before building

### 1. PR 2 goes on the same branch as PR 1, so it would land in PR 1

PR 1 is opened from `adit/mcp-login-menu`, and Task 6 says to "open PR 1 and stop". PR 2 then says "Keep working on the same branch." While PR 1 is open, every commit pushed to `adit/mcp-login-menu` joins PR 1. So PR 1 would grow to hold the agency-lang changes, and the owner would review and merge both PRs as one.

**Change:** give PR 2 its own branch, for example `adit/mcp-login-menu-agent`, cut from `adit/mcp-login-menu` after PR 1 is opened. Open PR 2 with PR 1's branch as its base. After PR 1 merges, merge `origin/main` into the PR 2 branch and change PR 2's base to `main`. Never rebase it.

The plan also never says which commit adds the spec, the plan, and the three review files. They are untracked in the worktree today. Say that Task 1's commit adds them, so they ship with PR 1.

### 2. The guard for two refreshes at once compares against the wrong refresh token

The spec says `invalidateCredentials('tokens')` deletes the saved login "only when it is still the login that was rejected." Task 4 builds that as: `tokens()` remembers the `refresh_token` it last returned, and `invalidateCredentials('tokens')` deletes the file only when the file still holds that token.

`tokens()` runs on every request, not only before a refresh. The transport calls it to build each request's `Authorization` header (`client/streamableHttp.js:58-61`). So "the token `tokens()` last returned" is often the new one, and the guard deletes the good login anyway. Here is the plan's own test case, "two calls at expiry", step by step, on one client and one provider:

1. Calls A and B both get a 401. Each runs `auth()`, which calls `tokens()`. The provider remembers R1.
2. A refreshes with R1. The fake server returns R2 and forgets R1. The provider saves R2.
3. A's transport sends its request again and calls `tokens()` for the header. The provider now remembers R2.
4. B's refresh with R1 comes back `invalid_grant`. The SDK calls `invalidateCredentials('tokens')`.
5. The file holds R2, and the provider remembers R2. They match, so the provider deletes the good login.

Whether step 3 runs before step 4 depends on timing, so the test will fail some of the time or all of the time. An implementer who sees it fail has no way to fix it inside the plan's design.

The provider needs to know which refresh token the server rejected, and the SDK does not pass it to `invalidateCredentials`. It does use the transport's `fetch` for every token request: the transport hands `fetchFn: this._fetchWithInit` to `auth()` (`streamableHttp.js:322-327`), and `_fetchWithInit` wraps the `fetch` given in the transport's options (`:31-32`).

**Change:** have `OAuthConnector` give its transports a `fetch` that watches the token endpoint. When a request with `grant_type=refresh_token` gets a 400 response whose body has `"error": "invalid_grant"`, it records that request's `refresh_token` on the provider as the rejected one. `invalidateCredentials('tokens')` then deletes the file only when the file's `refresh_token` equals the rejected one. Add a provider unit test that runs steps 1 to 5 in that order by hand, with no timing involved, so the case is checked on every run and not only when the two calls overlap.

### 3. `_finishMcpLogin` must read the run before its first `await`

Task 9 says `_finishMcpLogin` reads the abort signal with `getRuntimeContext()`. It also says every function first returns its empty value when `_mcpPackageProblem()` is not empty, which needs an `await`.

`getRuntimeContext()` is the deprecated name for `currentRun()` (`lib/runtime/asyncContext.ts:435`). `currentRun()` throws after the function's first `await`, and its comment says to call it on the first line and keep the result (`asyncContext.ts:337-348`). `_openUrl` does this (`lib/stdlib/system.ts:84-86`). If the version check runs first, the later read throws "No run is current here".

**Change:** in Task 9, say that `_finishMcpLogin` calls `const run = currentRun()` on its first line, before the version check, and reads the signal from that run. For the abort test, name `runInTestContext` from `lib/runtime/asyncContext.ts` in place of "search the test files". The same first-await rule applies inside that helper.

### 4. A test-only environment variable goes into the published package

Task 6 has `getManager` read `AGENCY_MCP_CALLBACK_PORT` and tells the implementer not to document it. That puts a hidden switch into a package that users install, and its only purpose is one test file.

`mcp.exports.test.ts` is the only test that cannot pass a port. Every other package test passes `port` or `callbackPort` directly.

**Change:** pick one of these, and drop the environment variable.

1. Let `mcp.exports.test.ts` use the default port, 19876. It is the only test file that does. The cost is that the file fails if a login is waiting on that port on the developer's machine, for example a real `agency agent` waiting on a login.
2. Add `callbackPort` to an HTTP server's config, next to `authTimeout`. Claude Code has the same setting as `--callback-port`. It helps a user whose port 19876 is taken. The tests then set it in the config they pass. This is a new user-facing option, so it needs a line in the spec.

I would pick option 1, because option 2 adds an option nobody has asked for.

## Smaller findings

### 5. The existing wait in `redirectToAuthorization` would start the 5-minute timer at `startLogin`

`redirectToAuthorization` today calls `this.callbackServer.waitForCode()` before it branches, to settle the `complete` promise it gives `onOAuthRequired` (`oauthProvider.ts:162-167`). With Task 2, the first `waitForCode()` starts the timer. If that wiring stays where it is, the "login being started" branch starts the timer at `startLogin`, against the spec's rule that the time is counted from `finishLogin`.

**Change:** in Task 4's table, say that only the "ask first" branch sets up the `complete` promise and calls `waitForCode()`. Test 17 ("finishLogin counts its timeout from its own call") would catch this. Saying it saves a debugging round.

### 6. The menu does not say what happens when `beginLogin` fails

Task 11, step 3 says: "For `login`, push the lines from `beginLogin` first, then push the line from `endLogin`." `beginLogin` returns a `Result`. When `startMcpLogin` fails, there are no lines to push, and `endLogin` would print "no login in progress for <name>".

**Change:** say that when `beginLogin` fails, the menu pushes `<name>: <message>` and goes back to the list without calling `endLogin`.

### 7. Check the error from `callTool` too, not only from `connect`

The list of checks done only by reading has item 2: does an error thrown in `redirectToAuthorization` come out of `client.connect()` unchanged or wrapped? `McpManager.callTool` depends on the same answer for `client.callTool()`, which goes through `Protocol.request` and the transport's `send`. Both paths should use one helper that unwraps the error, and item 2 should name both.

### 8. A note for the "two calls at expiry" test: the SDK's 401 circuit breaker

The transport has one `_hasCompletedAuthFlow` flag for all its requests (`streamableHttp.js:25`). It is set after a successful `auth()` (`:332`) and cleared after a successful response (`:367`). A request that gets a 401 while the flag is set throws `Server returned 401 after successful authentication` (`:316-318`) and does not refresh.

With the fake server, both 401s arrive before either refresh finishes, so the test does not hit this. If the test ever fails with that message, the cause is this SDK flag, not the refresh guard. One sentence under the test would save that investigation.

### 9. The empty-config message still asks the user to edit JSON

`mcpSlashCommand` keeps "No MCP servers configured. Add an mcpServers block to agency.json or settings.json." That message is how this work started: the user wanted a way to add a server without editing JSON. `agency mcp add` exists. The spec does not change the message, so the plan is right to keep it. The owner may want one more line, such as "Or run: agency mcp add <name> --url <url>". This is the owner's call.

## What I checked and found correct

- The SDK reads `provider.redirectUrl` before any refresh (`auth.js:260`) and calls `provider.state()` before a new login (`auth.js:299`). A refresh that fails with a server error falls through to a new login (`auth.js:287-296`). The plan's background section is right on all three.
- `@capabilities` tags propagate to callers, so the test nodes in `tests/agency/mcp-logout.agency` and `tests/mcpMenu.agency` need none of their own (`docs/dev/language/capabilities.md`).
- `restore(cp, { maxRestores: N })` is the real call (`tests/agency/maxRestores.agency`). `toolsSurviveARestore` uses it correctly, and its loop-until-the-limit failure mode is a real test of "no Agency global holds the tools".
- `intr.data.<field>` is how a handler reads an interrupt's data (`docs/site/guide/handlers.md:117`), and `isFailure` exists. The `mcp-logout.agency` test reads them correctly.
- A rejected `std::openUrl` makes `openUrl` return a failure and lets `beginLogin` go on, because a rejection exits the function that raised the interrupt. So `rejectedOpenStillShowsTheUrl` tests what it says.
- The menu, the startup lines, and the actions table match the spec's screens, including "Reconnect" on the needs-login screen and "Connect" for a server with no state.
