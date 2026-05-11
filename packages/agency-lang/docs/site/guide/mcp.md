# MCP Servers

Agency supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), a standard protocol for connecting to external tool servers. This lets your agents use tools provided by MCP servers — filesystem access, databases, GitHub, and more — without reimplementing them as Agency functions.

## Installation

MCP support is provided by the `@agency-lang/mcp` package:

```bash
npm install @agency-lang/mcp
```

## Quick start

1. Configure an MCP server in `agency.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

2. Use its tools in your agent:

```ts
import { mcp } from "pkg::@agency-lang/mcp"

node main() {
  const tools = mcp("filesystem") catch []
  registerTools(tools)
  const result = llm("List the files in /tmp", { tools: [...tools] })
  print(result)
}
```

That's it. The `mcp()` function connects to the server, fetches its tools, and returns them as an array. You pass them to `llm()` via the `tools` option.

> Important: Make sure you register the tools with `registerTools()` so Agency recognizes them!

## How it works

`mcp()` returns a `Result` type. If the connection fails, it returns a `failure`. Use `catch` to provide a default:

```ts
import { mcp } from "pkg::@agency-lang/mcp"

// If the server is down, use an empty tool list instead of crashing
const tools = mcp("filesystem") catch []
```

Each tool in the array is an `AgencyFunction` with a `name`, `description`, and schema. Tool names are prefixed with the server name to avoid collisions: a `read_file` tool from a server named `filesystem` becomes `filesystem__read_file`.

You can filter tools before passing them to the LLM:

```ts
import { mcp } from "pkg::@agency-lang/mcp"

const allTools = mcp("filesystem") catch []
const safeTools = filter(allTools) as tool {
  return tool.name != "filesystem__delete_file"
}
const result = llm("Summarize my files", { tools: [...safeTools] })
```

You can also combine tools from multiple servers and your own Agency functions:

```ts
import { mcp } from "pkg::@agency-lang/mcp"

def summarize(text: string): string {
  return llm("Summarize this: ${text}")
}

node main() {
  const fsTools = mcp("filesystem") catch []
  const dbTools = mcp("database") catch []

  const result = llm("Read my files, query the database, and summarize everything", {
    tools: [summarize, ...fsTools, ...dbTools]
  })
  print(result)
}
```

## Configuration

MCP servers are configured in `agency.json` under the `mcpServers` key. The `@agency-lang/mcp` package reads this file automatically at runtime. There are two transport types.

### Stdio servers

Stdio servers run as local subprocesses. Agency spawns the process and communicates over stdin/stdout.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {
        "SOME_VAR": "value"
      }
    }
  }
}
```

- `command` (required): the command to run
- `args` (optional): arguments to pass
- `env` (optional): environment variables for the subprocess

### HTTP servers

HTTP servers run remotely and communicate over Streamable HTTP.

```json
{
  "mcpServers": {
    "weather": {
      "type": "http",
      "url": "https://weather-mcp.example.com/mcp"
    }
  }
}
```

- `type` (required): must be `"http"`
- `url` (required): the server's MCP endpoint URL

### HTTP servers with static headers

If the server requires an API key or token, you can pass static headers:

```json
{
  "mcpServers": {
    "weather": {
      "type": "http",
      "url": "https://weather-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    }
  }
}
```

## Authentication (OAuth)

Many MCP servers (like GitHub) require OAuth authentication. The `@agency-lang/mcp` package handles the full OAuth 2.1 flow — opening your browser, receiving the callback, and storing tokens for reuse.

### Setup

1. Register an OAuth App with the provider (e.g., [GitHub OAuth Apps](https://github.com/settings/developers)).
   - Set the callback URL to `http://127.0.0.1:19876/oauth/callback`
   - Note your Client ID and Client Secret.

2. Set your credentials as environment variables. The package looks for `MCP_<SERVER>_CLIENT_ID` and `MCP_<SERVER>_CLIENT_SECRET`, where the server name is uppercased and any hyphens are replaced with underscores:

```bash
export MCP_GITHUB_CLIENT_ID=your-client-id
export MCP_GITHUB_CLIENT_SECRET=your-client-secret
```

For a server named `my-api`, the env vars would be `MCP_MY_API_CLIENT_ID` and `MCP_MY_API_CLIENT_SECRET`.

3. Add the server to `agency.json`:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": "oauth"
    }
  }
}
```

You can also put `clientId` directly in the config file if you prefer (it's not a secret). Always use environment variables for the client secret.

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": "oauth",
      "clientId": "your-client-id"
    }
  }
}
```

4. The first time your agent connects, the package opens your browser for authorization. After you approve, the token is stored at `~/.agency/tokens/<server-name>.json` and reused automatically on future runs.

### OAuth config options

- `auth` (required): must be `"oauth"`
- `clientId` (optional): the OAuth client ID. Falls back to `MCP_<SERVER>_CLIENT_ID` env var.
- `clientSecret` (optional): the OAuth client secret. Falls back to `MCP_<SERVER>_CLIENT_SECRET` env var. **Use env vars for this.**
- `authTimeout` (optional): milliseconds to wait for the user to authorize in the browser. Defaults to 5 minutes.

Note: `auth` and `headers` are mutually exclusive — use one or the other. OAuth requires HTTPS (localhost is exempt for development).

### Using OAuth in Agency code

No special code is needed. The OAuth flow is handled automatically when you call `mcp()`:

```ts
import { mcp } from "pkg::@agency-lang/mcp"

node main() {
  const tools = mcp("github") catch []
  const result = llm("List my GitHub repositories", { tools: [...tools] })
  print(result)
}
```

On the first run, your browser opens for authorization. On subsequent runs, the stored token is used.

### Using OAuth from TypeScript

When importing and calling `mcp()` from TypeScript, you can customize the OAuth flow by passing an `onOAuthRequired` callback as the second argument:

```typescript
import { mcp } from "@agency-lang/mcp";

const result = await mcp("github", async ({ serverName, authUrl, complete }) => {
  // Show the URL to the user however you want
  console.log(`Please authorize at: ${authUrl}`);
  // Wait for the auth to complete
  await complete;
});
```

The callback receives:
- `serverName` — which MCP server needs authorization
- `authUrl` — the URL to send the user to
- `complete` — a promise that resolves when the user completes authorization
- `cancel` — a function to abort the OAuth flow

If you don't provide `onOAuthRequired`, the package opens the browser automatically (the default behavior).

**Note:** The `onOAuthRequired` callback is set once, on the first `mcp()` call that provides one. If you pass a different callback on a subsequent call, a warning is printed and the new callback is ignored. This is because all MCP servers share a single connection manager. The callback receives `serverName`, so you can branch on it to handle different servers differently within a single callback.

### Managing tokens with the CLI

You can manage OAuth tokens from the command line:

```bash
# Authorize a server (opens browser)
npx @agency-lang/mcp auth github

# List all stored tokens
npx @agency-lang/mcp auth --list

# Remove a stored token (forces re-authorization on next use)
npx @agency-lang/mcp auth --revoke github
```

## Interrupts and handlers

MCP tools are external and cannot throw Agency interrupts. If you want safety checks on MCP tool usage, you can:

- Filter out dangerous tools before passing them to `llm()`
- Wrap the `llm()` call in a `handle` block to intercept any interrupts from your own tools
