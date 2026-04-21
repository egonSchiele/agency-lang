# MCP Servers

Agency supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), a standard protocol for connecting to external tool servers. This lets your agents use tools provided by MCP servers — filesystem access, databases, GitHub, and more — without reimplementing them as Agency functions.

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
node main() {
  const tools = mcp("filesystem") catch []
  const result = llm("List the files in /tmp", { tools: [...tools] })
  print(result)
}
```

That's it. The `mcp()` function connects to the server, fetches its tools, and returns them as an array. You pass them to `llm()` via the `tools` option.

## How it works

`mcp()` returns a `Result` type. If the connection fails, it returns a `failure`. Use `catch` to provide a default:

```ts
// If the server is down, use an empty tool list instead of crashing
const tools = mcp("filesystem") catch []
```

Each tool in the array is a plain object with a `name`, `description`, and `inputSchema`. Tool names are prefixed with the server name to avoid collisions: a `read_file` tool from a server named `filesystem` becomes `filesystem__read_file`.

You can filter tools before passing them to the LLM:

```ts
const allTools = mcp("filesystem") catch []
const safeTools = filter(allTools) as tool {
  return tool.name != "filesystem__delete_file"
}
const result = llm("Summarize my files", { tools: [...safeTools] })
```

You can also combine tools from multiple servers and your own Agency functions:

```ts
def summarize(text: string): string {
  return llm("Summarize this: ${text}")
}

node main() {
  const fsTools = mcp("filesystem") catch []
  const dbTools = mcp("database") catch []

  uses summarize
  const result = llm("Read my files, query the database, and summarize everything", {
    tools: [summarize, ...fsTools, ...dbTools]
  })
  print(result)
}
```

## Configuration

MCP servers are configured in `agency.json` under the `mcpServers` key. There are two transport types.

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

Many MCP servers (like GitHub) require OAuth authentication. Agency handles the full OAuth 2.1 flow — opening your browser, receiving the callback, and storing tokens for reuse.

### Setup

1. Register an OAuth App with the provider (e.g., [GitHub OAuth Apps](https://github.com/settings/developers)).
   - Set the callback URL to `http://127.0.0.1:19876/oauth/callback`
   - Note your Client ID and Client Secret.

2. Add the server to `agency.json`:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": "oauth",
      "clientId": "your-client-id",
      "clientSecret": "your-client-secret"
    }
  }
}
```

Alternatively, you can set credentials as environment variables instead of putting them in the config file. Agency checks for `MCP_<SERVER>_CLIENT_ID` and `MCP_<SERVER>_CLIENT_SECRET` (server name uppercased) as a fallback:

```bash
export MCP_GITHUB_CLIENT_ID=your-client-id
export MCP_GITHUB_CLIENT_SECRET=your-client-secret
```

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

3. The first time your agent connects, Agency opens your browser for authorization. After you approve, the token is stored at `~/.agency/tokens/<server-name>.json` and reused automatically on future runs.

### OAuth config options

- `auth` (required): must be `"oauth"`
- `clientId` (optional): the OAuth client ID. Falls back to `MCP_<SERVER>_CLIENT_ID` env var.
- `clientSecret` (optional): the OAuth client secret. Falls back to `MCP_<SERVER>_CLIENT_SECRET` env var.
- `authTimeout` (optional): milliseconds to wait for the user to authorize in the browser. Defaults to 5 minutes.

Note: `auth` and `headers` are mutually exclusive — use one or the other.

### Using OAuth in Agency code

No special code is needed. The OAuth flow is handled automatically by the runtime when you call `mcp()`:

```ts
node main() {
  const tools = mcp("github") catch []
  const result = llm("List my GitHub repositories", { tools: [...tools] })
  print(result)
}
```

On the first run, your browser opens for authorization. On subsequent runs, the stored token is used.

### Using OAuth from TypeScript

When you import and call an Agency node from TypeScript, the OAuth flow works the same way — it opens a browser. If you need to customize this (e.g., in a web app where you can't open a local browser), provide an `onOAuthRequired` callback:

```ts
import { main } from "./agent.js";

const result = await main({
  callbacks: {
    onOAuthRequired: async ({ serverName, authUrl, complete }) => {
      // Show the URL to the user however you want
      console.log(`Please authorize at: ${authUrl}`);
      // Wait for the auth to complete
      await complete;
    }
  }
});
```

The callback receives:
- `serverName` — which MCP server needs authorization
- `authUrl` — the URL to send the user to
- `complete` — a promise that resolves when the user completes authorization
- `cancel` — a function to abort the OAuth flow

If you don't provide `onOAuthRequired`, Agency opens the browser automatically (the default behavior).

### Managing tokens with the CLI

You can manage OAuth tokens from the command line:

```bash
# Authorize a server (opens browser)
agency auth github

# List all stored tokens
agency auth --list

# Remove a stored token (forces re-authorization on next use)
agency auth --revoke github
```

## Interrupts and handlers

MCP tools are external and cannot throw Agency interrupts. If you want safety checks on MCP tool usage, you can:

- Filter out dangerous tools before passing them to `llm()`
- Wrap the `llm()` call in a `handle` block to intercept any interrupts from your own tools
