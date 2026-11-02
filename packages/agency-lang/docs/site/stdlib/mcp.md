---
name: "mcp"
description: "Load MCP tools and report server connection status."
---

# mcp

Read project server settings, merge them with global settings, and load
  tools for use in `llm()`. Calls to loaded tools raise `mcp::call` so handlers
  and policies can approve or reject them.

  ```ts
  import { readProjectMcpConfig, loadMcpToolsWithStatus } from "std::mcp"

  const servers = readProjectMcpConfig(".")
  const loaded = loadMcpToolsWithStatus(servers)
  printJSON(loaded.status)
  ```

## Types

### McpLoadResult

Loaded tools and each server's "connected" or "unavailable" status.

```ts
/** Loaded tools and each server's "connected" or "unavailable" status. */
export type McpLoadResult = {
  tools: any[];
  status: Record<string, string>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L25))

## Effects

### mcp::call

```ts
@always(server, tool)
effect mcp::call {
  server: string;
  tool: string;
  args: Record<string, any>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L34))

## Functions

### isMcpAvailable

```ts
isMcpAvailable(): boolean
```

True when the @agency-lang/mcp package is installed and reachable.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L40))

### readProjectMcpConfig

```ts
readProjectMcpConfig(dir: string): Record<string, any>
```

Read the mcpServers block from the project agency.json under `dir`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Record<string, any>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L46))

### mergeMcpServers

```ts
mergeMcpServers(
  global: Record<string, any>,
  project: Record<string, any>,
): Record<string, any>
```

Merge global and project mcpServers configs (project wins on collision).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| global | `Record<string, any>` |  |
| project | `Record<string, any>` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L51))

### loadMcpTools

```ts
loadMcpTools(merged: Record<string, any>, onOAuthRequired = null): any[]
```

Load gated MCP tools for every server in `merged`. Returns [] when the
  package is absent, incompatible, or no servers are configured.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| merged | `Record<string, any>` |  |
| onOAuthRequired |  | null |

**Returns:** `any[]`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L57))

### loadMcpToolsWithStatus

```ts
loadMcpToolsWithStatus(
  merged: Record<string, any>,
  onOAuthRequired = null,
): McpLoadResult
```

Load MCP tools and report which servers connected.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| merged | `Record<string, any>` |  | Server configurations, such as the output of mergeMcpServers. |
| onOAuthRequired |  | null |  |

**Returns:** [McpLoadResult](#mcploadresult)

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L64))
