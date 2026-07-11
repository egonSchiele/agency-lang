# Using MCP servers with the agent

The agency agent can use tools from external [MCP](https://modelcontextprotocol.io)
(Model Context Protocol) servers — filesystem access, GitHub, databases, and the
rest of the MCP ecosystem. Every MCP tool call is gated by the agent's approval
policy, so a side-effectful call cannot happen without your say-so.

## Install

MCP support ships as a separate package. Install it alongside `agency-lang`:

```bash
npm install @agency-lang/mcp
```

When the package is not installed, the agent runs normally with zero MCP tools.

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

The agent connects to each server at startup, discovers its tools, and hands them
to the coordinator. Tool names are prefixed with the server name — `read_file`
from the `filesystem` server appears to the model as `filesystem__read_file`. A
server that fails to connect is skipped with a warning; the agent and the other
servers keep working.

## Managing servers (`mcp add` / `remove` / `list`)

You can manage servers without editing JSON, from the CLI or the REPL. Both
default to the **project** `agency.json`; pass `--global` to write the agent-home
`settings.json` instead. A server is validated before it is written.

**CLI:**

```bash
# stdio server (args are comma-separated; values cannot contain a comma)
agency agent mcp add filesystem --command npx \
  --args -y,@modelcontextprotocol/server-filesystem,/tmp

# HTTP server, with OAuth
agency agent mcp add github --url https://api.githubcopilot.com/mcp/ --oauth --global

agency agent mcp remove filesystem
agency agent mcp list          # shows each server with its source (project/global)
```

**In the REPL** — same syntax after `/mcp`, and an added server **hot-connects**
so its tools are usable immediately (no restart):

```
/mcp add filesystem --command npx --args -y,@modelcontextprotocol/server-filesystem,/tmp
/mcp remove filesystem
```

`--oauth` only sets `auth: "oauth"`; OAuth client credentials are never written to
config — supply them via the environment (see below).

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

You can also choose "always" at a prompt; the agent remembers it for that exact
`server` + `tool`.

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

## OAuth servers

For a server that requires signing in, add `"auth": "oauth"`. On first use your
browser opens for authorization; the token is cached at `~/.agency/tokens/` and
reused automatically afterward.

Limitations:

- **Interactive only.** In `--print` / one-shot mode there is no browser prompt,
  so an unauthorized OAuth server reports a clear error. Authorize once
  interactively; the cached token then works everywhere.
- **Browser auto-open is macOS-only** today. On other systems the agent prints
  the authorization URL for you to open.
- OAuth requires an HTTPS URL (localhost excepted).

## `/mcp`

In the interactive REPL, `/mcp` lists your configured servers and the number of
MCP tools loaded this session. When the package is not installed it points you at
the install command.

## Advanced: `AGENCY_MCP_PATH`

`@agency-lang/mcp` must be resolvable from the agent — install it alongside
`agency-lang` in the same project, or globally (`npm i -g` / `pnpm add -g`). If it
lives somewhere else, set `AGENCY_MCP_PATH` to the absolute path of the package's
entry (`.../@agency-lang/mcp/dist/src/mcp.js`) and the agent will use it.
