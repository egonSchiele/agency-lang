---
name: "mcp"
description: "Load MCP tools, report server connection status, and log in to servers."
---

# mcp

Read project server settings, merge them with global settings, and load
  tools for use in `llm()`. Calls to loaded tools raise `mcp::call` so handlers
  and policies can approve or reject them.

  `connectMcpServers` connects servers without ever starting a login. A server
  that needs one gets the status `needsLogin`. `startMcpLogin` and
  `finishMcpLogin` log in to it in two steps, so the program can open the
  login page with `openUrl` in between. `logoutMcpServer` deletes a saved
  login and raises `mcp::logout`. These functions need `@agency-lang/mcp`
  0.0.6 or newer; `mcpPackageProblem` says when the installed one is older.

  Every function that can start a stdio server's command raises `mcp::connect`
  with the server's name and command line first. A server that is not
  approved is not started. HTTP servers start no process and raise nothing.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L50))

### McpServerState

One MCP server's state. `message` is empty unless the status is "failed".
  `tools` is empty unless the status is "connected".

```ts
/** One MCP server's state. `message` is empty unless the status is "failed".
  `tools` is empty unless the status is "connected". */
export type McpServerState = {
  name: string;
  status: "connected" | "needsLogin" | "failed";
  message: string;
  tools: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L164))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L59))

### mcp::connect

```ts
@always(server, command)
effect mcp::connect {
  server: string;
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L68))

### mcp::logout

```ts
@always(server)
effect mcp::logout {
  server: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L173))

## Functions

### isMcpAvailable

```ts
isMcpAvailable(): boolean
```

True when the @agency-lang/mcp package is installed and reachable.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L121))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L127))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L132))

### loadMcpTools

```ts
loadMcpTools(
  merged: Record<string, any>,
  onOAuthRequired = null,
): any[] raises <mcp::connect>
```

Load gated MCP tools for every server in `merged`. Asks before starting
  each stdio server, and skips one that is not approved. Returns [] when the
  package is absent, incompatible, or no servers are configured.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| merged | `Record<string, any>` |  |
| onOAuthRequired |  | null |

**Returns:** `any[]`

**Throws:** `mcp::connect`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L138))

### loadMcpToolsWithStatus

```ts
loadMcpToolsWithStatus(
  merged: Record<string, any>,
  onOAuthRequired = null,
): McpLoadResult raises <mcp::connect>
```

Load MCP tools and report which servers connected. Asks before starting
  each stdio server. A server that is not approved is "unavailable".

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| merged | `Record<string, any>` |  | Server configurations, such as the output of mergeMcpServers. |
| onOAuthRequired |  | null |  |

**Returns:** [McpLoadResult](#mcploadresult)

**Throws:** `mcp::connect`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L147))

### mcpPackageProblem

```ts
mcpPackageProblem(): string
```

Return why the installed @agency-lang/mcp is too old for the server-state
  functions, with the command to upgrade it. Returns an empty string when it
  is new enough or not installed.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L177))

### connectMcpServers

```ts
connectMcpServers(
  merged: Record<string, any>,
): McpServerState[] raises <mcp::connect>
```

Connect every server in `merged` and return each one's state. Asks before
  starting each stdio server; one that is not approved is "failed". Never
  starts a login: a server that needs one comes back as "needsLogin".

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| merged | `Record<string, any>` |  | Server configurations, such as the output of mergeMcpServers. |

**Returns:** `McpServerState[]`

**Throws:** `mcp::connect`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L187))

### configureMcpServers

```ts
configureMcpServers(merged: Record<string, any>)
```

Store the server configurations without connecting anything.
  connectPendingMcpServers connects them later.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| merged | `Record<string, any>` |  | Server configurations, such as the output of mergeMcpServers. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L209))

### connectPendingMcpServers

```ts
connectPendingMcpServers(): McpServerState[] raises <mcp::connect>
```

Connect every stored server that has no state yet, and return their states.
  Asks before starting each stdio server, the same way connectMcpServers does.

**Returns:** `McpServerState[]`

**Throws:** `mcp::connect`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L220))

### mcpServerStates

```ts
mcpServerStates(): McpServerState[]
```

Return the current state of every MCP server connected so far, with the
  tools of each connected one. Connects nothing.

**Returns:** `McpServerState[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L232))

### startMcpLogin

```ts
startMcpLogin(merged: Record<string, any>, name: string): Result<string>
```

Start a login to an MCP server and return the URL of its login page,
  without waiting. Call finishMcpLogin to wait for the person to log in.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| merged | `Record<string, any>` |  | Server configurations, such as the output of mergeMcpServers. |
| name | `string` |  | The server's name in the mcpServers config. |

**Returns:** `Result<string>`

**Needs:** `fileRead`, `fileWrite`, `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L241))

### finishMcpLogin

```ts
finishMcpLogin(name: string): McpServerState
```

Wait for the person to finish the login startMcpLogin began, then connect
  to the server and return its state.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The server's name in the mcpServers config. |

**Returns:** [McpServerState](#mcpserverstate)

**Needs:** `fileRead`, `fileWrite`, `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L253))

### cancelMcpLogin

```ts
cancelMcpLogin(name: string)
```

Stop a login to an MCP server that is in progress.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The server's name in the mcpServers config. |

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L264))

### disconnectMcpServer

```ts
disconnectMcpServer(name: string)
```

Close the connection to an MCP server and drop its tools. The saved login
  stays, and nothing connects to the server again until it is reconnected.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The server's name in the mcpServers config. |

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L274))

### mcpNotInstalled

```ts
mcpNotInstalled(): string
```

Return the message that says @agency-lang/mcp is not installed, with the
  command to install it.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L284))

### logoutMcpServer

```ts
logoutMcpServer(name: string): Result raises <mcp::logout>
```

Delete the saved login for an MCP server and disconnect from it.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The server's name in the mcpServers config. |

**Returns:** `Result`

**Throws:** `mcp::logout`

**Needs:** `fileWrite`, `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L293))

### reconnectMcpServer

```ts
reconnectMcpServer(
  merged: Record<string, any>,
  name: string,
): McpServerState raises <mcp::connect>
```

Disconnect from an MCP server and connect again with its saved login.
  Asks before starting a stdio server; one that is not approved is "failed".
  Never starts a login.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| merged | `Record<string, any>` |  | Server configurations, such as the output of mergeMcpServers. |
| name | `string` |  | The server's name in the mcpServers config. |

**Returns:** [McpServerState](#mcpserverstate)

**Throws:** `mcp::connect`

**Needs:** `fileRead`, `fileWrite`, `network`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/mcp.agency#L307))
