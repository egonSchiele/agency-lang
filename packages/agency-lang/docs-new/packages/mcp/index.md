# index

## Installation

```
npm install @agency-lang/mcp
```

## Usage

Configure MCP servers in your `agency.json`:

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

Then use `mcp()` to get tools from a configured server:

```ts
import { mcp } from "pkg::@agency-lang/mcp"

node main() {
  const tools = mcp("filesystem") catch []
  const result = llm("List files in /tmp", { tools: [...tools] })
  print(result)
}
```

See the [MCP guide](/guide/mcp) for more details on configuration, OAuth, and tool filtering.

## Functions

### mcp

```ts
mcp(serverName: string, onOAuthRequired)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| serverName | `string` |  |
| onOAuthRequired |  | null |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/mcp/index.agency#L40))
