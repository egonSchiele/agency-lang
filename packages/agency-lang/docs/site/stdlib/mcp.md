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
effect mcp::call {
  server: string;
  tool: string;
  args: Record<string, any>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L23))

## Functions

### isMcpAvailable

```ts
isMcpAvailable(): boolean
```

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L30))

### readProjectMcpConfig

```ts
readProjectMcpConfig(dir: string): Record<string, any>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L35))

### mergeMcpServers

```ts
mergeMcpServers(global: Record<string, any>, project: Record<string, any>): Record<string, any>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| global | `Record<string, any>` |  |
| project | `Record<string, any>` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L40))

### loadMcpTools

```ts
loadMcpTools(merged: Record<string, any>, onOAuthRequired): any[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| merged | `Record<string, any>` |  |
| onOAuthRequired |  | null |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L46))

### loadMcpToolsWithStatus

```ts
loadMcpToolsWithStatus(merged: Record<string, any>, onOAuthRequired): McpLoadResult
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| merged | `Record<string, any>` |  |
| onOAuthRequired |  | null |

**Returns:** [McpLoadResult](#mcploadresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L51))
