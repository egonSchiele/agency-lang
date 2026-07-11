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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L10))

## Functions

### isMcpAvailable

```ts
isMcpAvailable(): boolean
```

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L17))

### readProjectMcpConfig

```ts
readProjectMcpConfig(dir: string): Record<string, any>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Record<string, any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L22))
