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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L20))

## Effects

### mcp::call

```ts
effect mcp::call {
  server: string;
  tool: string;
  args: Record<string, any>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L28))

## Functions

### isMcpAvailable

```ts
isMcpAvailable(): boolean
```

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L35))

### readProjectMcpConfig

```ts
readProjectMcpConfig(dir: string): Record<string, any>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L40))

### mergeMcpServers

```ts
mergeMcpServers(
  global: Record<string, any>,
  project: Record<string, any>,
): Record<string, any>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| global | `Record<string, any>` |  |
| project | `Record<string, any>` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L45))

### loadMcpTools

```ts
loadMcpTools(merged: Record<string, any>, onOAuthRequired = null): any[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| merged | `Record<string, any>` |  |
| onOAuthRequired |  | null |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L51))

### loadMcpToolsWithStatus

```ts
loadMcpToolsWithStatus(
  merged: Record<string, any>,
  onOAuthRequired = null,
): McpLoadResult
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| merged | `Record<string, any>` |  |
| onOAuthRequired |  | null |

**Returns:** [McpLoadResult](#mcploadresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L56))

### loadMcpToolsForServer

```ts
loadMcpToolsForServer(
  server: string,
  merged: Record<string, any>,
  onOAuthRequired = null,
): any[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| server | `string` |  |
| merged | `Record<string, any>` |  |
| onOAuthRequired |  | null |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L61))

### addMcpServer

```ts
addMcpServer(
  name: string,
  config: Record<string, any>,
  file: string,
): Record<string, any>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| config | `Record<string, any>` |  |
| file | `string` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L67))

### removeMcpServer

```ts
removeMcpServer(name: string, file: string): boolean
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| file | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L72))

### parseMcpCommand

```ts
parseMcpCommand(argstr: string): Record<string, any>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| argstr | `string` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L78))

### dropMcpToolsForServer

```ts
dropMcpToolsForServer(tools: any[], server: string): any[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| tools | `any[]` |  |
| server | `string` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L83))
