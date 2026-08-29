---
name: "mcp"
---

# mcp

## Types

### McpLoadResult

```ts
export type McpLoadResult = {
  tools: any[];
  status: Record<string, string>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L15))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L24))

## Functions

### isMcpAvailable

```ts
isMcpAvailable(): boolean
```

True when the @agency-lang/mcp package is installed and reachable.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L30))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L35))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L40))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L45))

### loadMcpToolsWithStatus

```ts
loadMcpToolsWithStatus(
  merged: Record<string, any>,
  onOAuthRequired = null,
): McpLoadResult
```

Like loadMcpTools, but also returns a per-server status map for /mcp.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| merged | `Record<string, any>` |  |
| onOAuthRequired |  | null |

**Returns:** [McpLoadResult](#mcploadresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L51))
