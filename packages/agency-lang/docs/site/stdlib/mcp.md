---
name: "mcp"
---

# mcp

## Effects

### mcp::call

```ts
effect mcp::call {
  server: string;
  tool: string;
  args: Record<string, any>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L15))

## Functions

### isMcpAvailable

```ts
isMcpAvailable(): boolean
```

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L22))

### readProjectMcpConfig

```ts
readProjectMcpConfig(dir: string): Record<string, any>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L27))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L32))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L38))
