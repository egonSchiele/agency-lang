# Using MCP servers with the agent

*This feature is still a work in progress. It may not work or this documentation may be out of date.*

The Agency agent can use tools from external [MCP](https://modelcontextprotocol.io)
(Model Context Protocol) servers — filesystem access, GitHub, databases, and the
rest of the MCP ecosystem. Every MCP tool call is gated by the agent's approval
policy, so a side-effectful call cannot happen without your say-so.

## Install

MCP support ships as a separate package. Install it globally, next to `agency-lang`:

```bash
npm install -g @agency-lang/mcp
```

When the package is not installed, the agent runs normally with zero MCP tools.

The agent needs `@agency-lang/mcp` 0.0.6 or newer. With an older version it connects no servers, and prints this at startup:

```
MCP: @agency-lang/mcp 0.0.5 is too old. Run: npm install -g @agency-lang/mcp@latest
```

## Declare servers

Servers are declared in an `mcpServers` block. Two places are read and merged:

- **Project** — `agency.json` in your working directory (this project only).
- **Global** — `settings.json` in the agent home (`~/.agency-agent`, every project).

On a name collision the **project** entry wins.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": "oauth"
    }
  }
}
```

The agent connects to your servers when you send your first message. Before it
starts a stdio server, it asks you to approve the command (see
[Approvals](#approvals)). It never starts a login on its own. After connecting,
it prints one line for each server that is not ready, and keeps going with the
rest:

```
MCP: linear needs you to log in. Type /mcp to log in.
MCP: github failed to connect: connect ECONNREFUSED 127.0.0.1:3000
```

Tool names are prefixed with the server name: `read_file` from the `filesystem`
server appears to the model as `filesystem__read_file`.

## Managing servers (`agency mcp add` / `remove` / `list`)

You can manage servers without editing JSON, using the `agency mcp` commands.
They default to the **project** `agency.json`; pass `--global` to write the
agent-home `settings.json` instead. A server is validated before it is written,
and other keys in the file are preserved.

```bash
# stdio server (args are comma-separated; values cannot contain a comma)
agency mcp add filesystem --command npx \
  --args -y,@modelcontextprotocol/server-filesystem,/tmp

# HTTP server, with OAuth
agency mcp add github --url https://api.githubcopilot.com/mcp/ --oauth --global

agency mcp remove filesystem
agency mcp list          # shows each server with its source (project/global)
```

`--oauth` only sets `auth: "oauth"`; OAuth client credentials are never written to
config — supply them via the environment (see below).

You can run these while the agent is open. The next time you type `/mcp`, the
agent reads the config again. A server you added connects right away (a stdio
server asks first). A server you removed is disconnected, and its tools go away.

## Approvals

By default the agent **prompts before every MCP tool call**. To avoid repeating
yourself, add rules to your policy file. Rules match on the **server** and the
**tool** name (exact or glob):

```json
{
  "mcp::call": [
    { "match": { "server": "filesystem", "tool": "read_file" }, "action": "approve" },
    { "match": { "server": "github" }, "action": "reject" }
  ]
}
```

You can also answer "always approve when" at a prompt. The agent then remembers
the answer for that exact `server` and `tool`.

Policy-file rules **cannot** match on a tool's *arguments* (they are a nested,
per-tool object). For argument-level control, write a `handle mcp::call` block:

```
handle mcp::call {
  ...
} with (e) {
  // e.args.path is the path the agent wants to read
  if (!startsWith(e.args.path, "/tmp/")) { return reject() }
  return approve()
}
```

### Starting a stdio server

A stdio server is a command on your machine, so the agent asks before it starts
one ("Are you sure you want to start this MCP server?"). The question shows the
server's name, its command line, and its environment variables. A word with a
space in it is shown in quotes, so you can see exactly what will run. For
example, `{ "command": "sh", "args": ["-c", "echo hi"] }` shows as
`sh -c "echo hi"`.

"Always approve when" remembers all three, so a changed command or a changed
environment asks again. A policy rule can approve a server up front:

```json
{
  "mcp::connect": [
    { "match": { "server": "filesystem" }, "action": "approve" }
  ]
}
```

If you reject a server, it is not started. It shows as failed in `/mcp`, and the
agent does not ask again until you pick "Reconnect" there. HTTP servers start no
process, so they never ask.

### Logging out

Logging out deletes a saved login, so the agent asks before it does that too
(the effect is `mcp::logout`). A rule that approves `mcp::logout` skips the
question.

## OAuth servers

For a server that requires signing in, add `"auth": "oauth"`, or pass `--oauth`
to `agency mcp add`. The agent never opens a login on its own. When a server
needs one, startup says so:

```
MCP: linear needs you to log in. Type /mcp to log in.
```

To log in:

1. Type `/mcp`, pick the server, and pick "Log in".
2. The agent asks before it opens the login page in your browser. It also
   prints the URL, so you can open it yourself if you say no, or if the browser
   does not open. Opening the browser works on macOS only today.
3. Log in in the browser. The agent waits up to 5 minutes. Press Escape to stop
   waiting.

When the login finishes, the server's tools work from your next message. You do
not need to restart. The login is saved in `~/.agency/tokens/` and reused on
later runs.

When a saved login expires, the agent refreshes it on its own. If the server
refuses the refresh, the tool call fails with
`MCP server "linear" needs a new login.`, and you log in again from `/mcp`.

Limitations:

- **Logging in is interactive.** In `--print` / one-shot mode there is no menu.
  Log in once in the REPL. The saved login then works everywhere.
- **One login at a time.** Every login uses port 19876 on your machine for the
  browser to return to. If another agency process is in the middle of a login,
  yours fails with `another login is in progress (port 19876 is in use)`.
- OAuth requires an HTTPS URL (localhost excepted).

## `/mcp`

In the interactive REPL, `/mcp` opens a menu. It first lists every configured
server with its status:

```
? MCP servers ›
❯   back - Back
    linear - !needs login
    filesystem - ✔ connected · 14 tools
    github - ✘ failed
    notes - ○ not connected
```

Pick a server to see its details and what you can do with it. You can also type
part of a name to narrow the list.

```
linear

  Status:  !needs login
  URL:     https://mcp.linear.app/mcp
  Config:  ~/.agency-agent/settings.json (global)

? Pick an action ›
❯   login - Log in
    reconnect - Reconnect
    back - Back
```

The actions depend on the server's status:

| Status | Actions |
|---|---|
| Needs login | Log in, Reconnect |
| Connected (OAuth) | View tools, Log in again, Log out, Reconnect |
| Connected (other) | View tools, Reconnect |
| Failed | Reconnect |
| Not connected | Connect |

Every server's screen also has "Back", which returns to the list. "Back" at the
top of the list leaves the menu. Escape leaves the menu from either screen.
"Reconnect" connects again with the saved login, and never starts a new one.

When no servers are configured, `/mcp` says how to add one. When the package is
not installed or too old, it prints the command to install or upgrade it.

## Advanced: `AGENCY_MCP_PATH`

`@agency-lang/mcp` must be resolvable from the agent — install it alongside
`agency-lang` in the same project, or globally (`npm i -g` / `pnpm add -g`). If it
lives somewhere else, set `AGENCY_MCP_PATH` to the absolute path of the package's
entry (`.../@agency-lang/mcp/dist/src/mcp.js`) and the agent will use it.
