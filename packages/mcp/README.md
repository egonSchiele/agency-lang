# @agency-lang/mcp

MCP (Model Context Protocol) support for the [Agency language](https://github.com/egonSchiele/agency-lang). Connects your Agency agents to external tool servers — filesystem access, databases, GitHub, and more.

## Installation

```bash
npm install @agency-lang/mcp
```

Requires `agency-lang` and `zod` as peer dependencies.

## Usage

Import `mcp()` in your `.agency` file and pass tools to `llm()`:

```
import { mcp } from "pkg::@agency-lang/mcp"

node main() {
  const tools = mcp("filesystem") catch []
  const result = llm("List the files in /tmp", { tools: [...tools] })
  print(result)
}
```

## Configuration

Configure MCP servers in `agency.json`:

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

HTTP servers are also supported:

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

## OAuth

For servers that require OAuth (like GitHub), add `"auth": "oauth"` to the config and set environment variables for your credentials:

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

The first time you connect, your browser opens for authorization. Tokens are stored at `~/.agency/tokens/` and reused automatically.

### Managing tokens

```bash
npx @agency-lang/mcp auth github        # Authorize a server
npx @agency-lang/mcp auth --list        # List stored tokens
npx @agency-lang/mcp auth --revoke github  # Remove a token
```

## TypeScript usage

```typescript
import { mcp } from "@agency-lang/mcp";

const result = await mcp("filesystem");
if (result.success) {
  console.log("Tools:", result.value);
}
```

For custom OAuth handling, pass a callback as the second argument:

```typescript
const result = await mcp("github", async ({ authUrl, complete }) => {
  console.log(`Please authorize at: ${authUrl}`);
  await complete;
});
```

## Documentation

See the full [MCP guide](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/docs-new/guide/mcp.md) for details on configuration options, tool filtering, combining tools from multiple servers, and more.
