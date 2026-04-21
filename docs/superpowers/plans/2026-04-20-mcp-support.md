# MCP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP (Model Context Protocol) support to Agency so users can connect to MCP servers and use their tools in LLM calls via a new `mcp()` built-in function.

**Architecture:** The `mcp()` built-in delegates to `McpManager` on `RuntimeContext`, which manages `McpConnection` instances (one per server). Connections are shared across parallel executions and cached for the agent lifetime. MCP tools are returned as plain objects with an `__mcpTool` marker; a helper in `lib/runtime/mcp/` transforms them into `{ definition, handler }` pairs at `llm()` call time.

**Tech Stack:** `@modelcontextprotocol/sdk` (MCP client + test server), Zod (config validation), vitest (testing)

**Spec:** `docs/superpowers/specs/2026-04-20-mcp-support-design.md`

---

### Task 1: Add `@modelcontextprotocol/sdk` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the MCP SDK**

Run: `pnpm add @modelcontextprotocol/sdk`

- [ ] **Step 2: Verify installation**

Run: `pnpm ls @modelcontextprotocol/sdk`
Expected: Shows the installed version

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat: add @modelcontextprotocol/sdk dependency for MCP support"
```

---

### Task 2: Add Zod schema for AgencyConfig and MCP server config types

**Files:**
- Modify: `lib/config.ts`

**Context:** `lib/config.ts` currently defines `AgencyConfig` as a plain TypeScript interface with no runtime validation. We need to add a Zod schema for the full config so the MCP section gets validated. Also add the `mcpServers` field to the type and schema.

- [ ] **Step 1: Write the test**

Create `lib/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AgencyConfigSchema } from "./config.js";

describe("AgencyConfigSchema", () => {
  it("should accept an empty config", () => {
    const result = AgencyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should accept a config with existing fields", () => {
    const result = AgencyConfigSchema.safeParse({
      verbose: true,
      outDir: "dist",
      maxToolCallRounds: 5,
    });
    expect(result.success).toBe(true);
  });

  it("should accept a config with stdio MCP server", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { FOO: "bar" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept a config with HTTP MCP server", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        weather: {
          type: "http",
          url: "https://weather-mcp.example.com/mcp",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept a config with mixed MCP servers", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        filesystem: { command: "npx", args: ["server"] },
        weather: { type: "http", url: "https://example.com/mcp" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should reject an HTTP server missing url", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        bad: { type: "http" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("should reject a stdio server missing command", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        bad: { args: ["foo"] },
      },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/config.test.ts`
Expected: FAIL — `AgencyConfigSchema` does not exist yet

- [ ] **Step 3: Add the Zod schema and MCP types to config.ts**

In `lib/config.ts`, add the Zod schema alongside the existing interface. Add `mcpServers` to the `AgencyConfig` interface and create the corresponding Zod schema. The schema should make all fields optional (matching the interface) and use `z.passthrough()` or `.passthrough()` where appropriate so that unknown fields don't cause validation failures (forward compatibility).

The MCP server config discriminated union:

```ts
import { z } from "zod";

const McpStdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const McpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
});

const McpServerSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);
```

Add to the `AgencyConfig` interface:

```ts
mcpServers?: Record<string, McpStdioServerConfig | McpHttpServerConfig>;
```

Export `AgencyConfigSchema`. The canonical TypeScript types for MCP server configs (`McpStdioServerConfig`, `McpHttpServerConfig`, `McpServerConfig`) will be defined later in `lib/runtime/mcp/types.ts` (Task 4). For the config schema, use `z.infer` to derive the types from the Zod schemas, and add a `mcpServers` field to `AgencyConfig` using inline types. The runtime types in `lib/runtime/mcp/types.ts` should be kept in sync with these schemas.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/config.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run existing tests to ensure nothing broke**

Run: `pnpm test:run`
Expected: All existing tests pass

- [ ] **Step 6: Commit**

```bash
git add lib/config.ts lib/config.test.ts
git commit -m "feat: add Zod schema for AgencyConfig with MCP server config types"
```

---

### Task 3: Add config validation to loadConfig

**Files:**
- Modify: `lib/cli/commands.ts`

**Context:** `loadConfig()` in `lib/cli/commands.ts` currently reads `agency.json` and JSON-parses it without validation. Add Zod validation using the new `AgencyConfigSchema`.

- [ ] **Step 1: Add Zod validation to loadConfig**

In `lib/cli/commands.ts`, after `JSON.parse(configContent)`, validate the parsed config with `AgencyConfigSchema.parse()`. If validation fails, print a helpful error message showing the Zod issues and exit.

```ts
import { AgencyConfigSchema } from "../config.js";

// Inside loadConfig, after JSON.parse:
const parseResult = AgencyConfigSchema.safeParse(config);
if (!parseResult.success) {
  console.error(`Invalid agency.json config:`);
  for (const issue of parseResult.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}
config = parseResult.data;
```

- [ ] **Step 2: Run existing tests to ensure nothing broke**

Run: `pnpm test:run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add lib/cli/commands.ts
git commit -m "feat: validate agency.json config using Zod schema"
```

---

### Task 4: Create McpConnection class

**Files:**
- Create: `lib/runtime/mcp/mcpConnection.ts`
- Create: `lib/runtime/mcp/types.ts`
- Create: `lib/runtime/mcp/mcpConnection.test.ts`

**Context:** `McpConnection` wraps a single MCP server connection. It uses `@modelcontextprotocol/sdk` to connect via stdio or HTTP, list tools, and call tools. Each method that can fail at runtime (connect, listTools, callTool) should handle errors gracefully.

**Docs to check:** The spec at `docs/superpowers/specs/2026-04-20-mcp-support-design.md`, sections on Runtime architecture and Tool name prefixing.

- [ ] **Step 1: Create the types file**

Create `lib/runtime/mcp/types.ts`:

```ts
export type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: "http";
  url: string;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpToolObject = {
  name: string;
  description: string;
  serverName: string;
  inputSchema: Record<string, unknown>;
  __mcpTool: true;
};
```

- [ ] **Step 2: Write the test for McpConnection**

Create `lib/runtime/mcp/mcpConnection.test.ts`. This test will spin up a real MCP server via stdio using the SDK's server module. We'll create a small inline test server script.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpConnection } from "./mcpConnection.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChildProcess, fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

describe("McpConnection", () => {
  it("should connect to a stdio server, list tools, and call a tool", async () => {
    const conn = new McpConnection("test", {
      command: "npx",
      args: ["tsx", TEST_SERVER_PATH],
    });

    await conn.connect();

    const tools = conn.getTools();
    expect(tools.length).toBeGreaterThan(0);

    const addTool = tools.find((t) => t.name === "test__add");
    expect(addTool).toBeDefined();
    expect(addTool!.serverName).toBe("test");
    expect(addTool!.__mcpTool).toBe(true);

    const result = await conn.callTool("add", { a: 3, b: 4 });
    expect(result).toContain("7");

    await conn.disconnect();
  });

  it("should return a failure when connecting to a nonexistent server", async () => {
    const conn = new McpConnection("bad", {
      command: "nonexistent-command-that-does-not-exist",
    });

    await expect(conn.connect()).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Create the test MCP server**

Create `lib/runtime/mcp/__tests__/testServer.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "test-server",
  version: "1.0.0",
});

server.tool(
  "add",
  "Add two numbers together",
  { a: z.number(), b: z.number() },
  async ({ a, b }) => {
    return {
      content: [{ type: "text", text: String(a + b) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Note: Check the `@modelcontextprotocol/sdk` docs to verify the exact API for `McpServer.tool()`. The signature may differ — adjust as needed based on what the SDK actually exports. You can check `node_modules/@modelcontextprotocol/sdk/dist` for the actual types.

- [ ] **Step 4: Implement McpConnection**

Create `lib/runtime/mcp/mcpConnection.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Note: check the SDK for the exact import path ��� may differ by version
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpToolObject } from "./types.js";

export class McpConnection {
  private client: Client;
  private serverName: string;
  private config: McpServerConfig;
  private tools: McpToolObject[] = [];
  private connected = false;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
    this.client = new Client({
      name: "agency-lang",
      version: "1.0.0",
    });
  }

  async connect(): Promise<void> {
    let transport;
    if ("command" in this.config) {
      transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env
          ? { ...process.env, ...this.config.env }
          : undefined,
      });
    } else {
      // HTTP transport
      // Note: check the SDK for the exact import path and class name — it may be
      // StreamableHTTPClientTransport or SSEClientTransport depending on version
      transport = new StreamableHTTPClientTransport(new URL(this.config.url));
    }

    await this.client.connect(transport);
    this.connected = true;

    // Eagerly fetch tools on connect
    const result = await this.client.listTools();
    this.tools = (result.tools || []).map((tool) => ({
      name: `${this.serverName}__${tool.name}`,
      description: tool.description || "",
      serverName: this.serverName,
      inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
      __mcpTool: true as const,
    }));
  }

  getTools(): McpToolObject[] {
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.client.callTool({ name: toolName, arguments: args });
    // MCP tool results have a `content` array; concatenate text entries
    const textParts = (result.content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    return textParts.join("\n");
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
```

Note: The exact import paths for the MCP SDK classes may differ. Check `node_modules/@modelcontextprotocol/sdk` for the actual exports. The HTTP transport class name might be `SSEClientTransport` or `StreamableHTTPClientTransport` depending on the SDK version. All imports must be static (no dynamic `import()`) per project rules.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run lib/runtime/mcp/mcpConnection.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/mcp/types.ts lib/runtime/mcp/mcpConnection.ts lib/runtime/mcp/mcpConnection.test.ts lib/runtime/mcp/__tests__/testServer.ts
git commit -m "feat: add McpConnection class for MCP server connections"
```

---

### Task 5: Create McpManager class

**Files:**
- Create: `lib/runtime/mcp/mcpManager.ts`
- Create: `lib/runtime/mcp/mcpManager.test.ts`

**Context:** `McpManager` is a connection pool. It manages `McpConnection` instances, caches them by server name, and provides `getTools()` which returns a `Result` type. It reads config from the `mcpServers` key in `AgencyConfig`.

**Docs to check:** The spec section on Runtime architecture. Also check `lib/runtime/result.ts` for the `success`/`failure` helpers.

- [ ] **Step 1: Write the test**

Create `lib/runtime/mcp/mcpManager.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { McpManager } from "./mcpManager.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

describe("McpManager", () => {
  let manager: McpManager;

  afterEach(async () => {
    if (manager) {
      await manager.disconnectAll();
    }
  });

  it("should connect to a server and return tools as a success Result", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    const result = await manager.getTools("test");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value[0].name).toBe("test__add");
    }
  });

  it("should cache connections (same instance on second call)", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    const result1 = await manager.getTools("test");
    const result2 = await manager.getTools("test");
    expect(result1).toEqual(result2);
  });

  it("should throw when server name is not in config", async () => {
    manager = new McpManager({});
    await expect(manager.getTools("nonexistent")).rejects.toThrow(
      /not found in agency.json/,
    );
  });

  it("should return a failure Result when connection fails", async () => {
    manager = new McpManager({
      bad: { command: "nonexistent-command-xyz" },
    });

    const result = await manager.getTools("bad");
    expect(result.success).toBe(false);
  });

  it("should disconnect all connections", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    await manager.getTools("test");
    await manager.disconnectAll();
    // After disconnect, getting tools should reconnect (or we verify it doesn't throw)
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/runtime/mcp/mcpManager.test.ts`
Expected: FAIL — `McpManager` does not exist yet

- [ ] **Step 3: Implement McpManager**

Create `lib/runtime/mcp/mcpManager.ts`:

```ts
import { McpConnection } from "./mcpConnection.js";
import type { McpServerConfig, McpToolObject } from "./types.js";
import { success, failure, type ResultValue } from "../result.js";

export class McpManager {
  private config: Record<string, McpServerConfig>;
  private connections: Record<string, McpConnection> = {};
  private toolCache: Record<string, McpToolObject[]> = {};

  constructor(config: Record<string, McpServerConfig>) {
    this.config = config;
  }

  async getTools(serverName: string): Promise<ResultValue> {
    // Config validation — programmer error, throw
    if (!this.config[serverName]) {
      throw new Error(
        `MCP server "${serverName}" not found in agency.json mcpServers config`,
      );
    }

    // Return cached tools if already connected
    if (this.toolCache[serverName]) {
      return success(this.toolCache[serverName]);
    }

    // Connect and fetch tools — runtime error, return Result
    try {
      const conn = new McpConnection(serverName, this.config[serverName]);
      await conn.connect();
      this.connections[serverName] = conn;
      this.toolCache[serverName] = conn.getTools();
      return success(this.toolCache[serverName]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return failure(
        `Failed to connect to MCP server "${serverName}": ${message}`,
      );
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const conn = this.connections[serverName];
    if (!conn) {
      // Attempt to reconnect (lazy reconnection after restore)
      if (this.config[serverName]) {
        const reconnConn = new McpConnection(serverName, this.config[serverName]);
        await reconnConn.connect();
        this.connections[serverName] = reconnConn;
        return reconnConn.callTool(toolName, args);
      }
      throw new Error(
        `No MCP connection for server "${serverName}" and no config to reconnect`,
      );
    }
    return conn.callTool(toolName, args);
  }

  async disconnectAll(): Promise<void> {
    const disconnects = Object.values(this.connections).map((conn) =>
      conn.disconnect().catch(() => {}),
    );
    await Promise.all(disconnects);
    this.connections = {};
    this.toolCache = {};
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/runtime/mcp/mcpManager.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/mcp/mcpManager.ts lib/runtime/mcp/mcpManager.test.ts
git commit -m "feat: add McpManager class for MCP connection pooling"
```

---

### Task 6: Create the MCP tool-to-handler helper

**Files:**
- Create: `lib/runtime/mcp/toolAdapter.ts`
- Create: `lib/runtime/mcp/toolAdapter.test.ts`

**Context:** When MCP tool objects (plain objects with `__mcpTool: true`) appear in the `tools` array on an `llm()` call, they need to be transformed into the `{ definition, handler }` shape that `prompt.ts` expects. This helper does that transformation, keeping MCP logic out of `prompt.ts`.

**Docs to check:** Look at `lib/runtime/prompt.ts` lines 24-35 for the `ToolHandler` and `Tool` types. Also check `lib/runtime/builtins.ts` line 4-7 for `ToolRegistryEntry`.

- [ ] **Step 1: Write the test**

Create `lib/runtime/mcp/toolAdapter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mcpToolToRegistryEntry, isMcpTool } from "./toolAdapter.js";
import type { McpToolObject } from "./types.js";

describe("isMcpTool", () => {
  it("should return true for MCP tool objects", () => {
    const tool: McpToolObject = {
      name: "test__add",
      description: "Add two numbers",
      serverName: "test",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
      __mcpTool: true,
    };
    expect(isMcpTool(tool)).toBe(true);
  });

  it("should return false for non-MCP objects", () => {
    expect(isMcpTool({ name: "foo" })).toBe(false);
    expect(isMcpTool(null)).toBe(false);
    expect(isMcpTool("string")).toBe(false);
  });
});

describe("mcpToolToRegistryEntry", () => {
  it("should produce a valid { definition, handler } pair", async () => {
    const tool: McpToolObject = {
      name: "test__add",
      description: "Add two numbers",
      serverName: "test",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      __mcpTool: true,
    };

    const mockCallTool = async (
      _serverName: string,
      _toolName: string,
      _args: Record<string, unknown>,
    ) => "7";

    const entry = mcpToolToRegistryEntry(tool, mockCallTool);

    expect(entry.definition.name).toBe("test__add");
    expect(entry.definition.description).toBe("Add two numbers");
    expect(entry.handler.name).toBe("test__add");
    expect(entry.handler.isBuiltin).toBe(false);
    expect(entry.handler.params).toEqual(["a", "b"]);

    // Test that the handler calls the mockCallTool
    // prompt.ts appends a context object as the last arg — include it to test stripping
    const result = await entry.handler.execute(3, 4, { ctx: null, threads: null, isToolCall: true });
    expect(result).toBe("7");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/runtime/mcp/toolAdapter.test.ts`
Expected: FAIL — module does not exist yet

- [ ] **Step 3: Implement toolAdapter**

Create `lib/runtime/mcp/toolAdapter.ts`:

```ts
import type { McpToolObject } from "./types.js";
import type { ToolRegistryEntry } from "../builtins.js";

export function isMcpTool(obj: any): obj is McpToolObject {
  return (
    obj !== null &&
    typeof obj === "object" &&
    obj.__mcpTool === true &&
    typeof obj.name === "string" &&
    typeof obj.serverName === "string"
  );
}

type CallToolFn = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

export function mcpToolToRegistryEntry(
  tool: McpToolObject,
  callTool: CallToolFn,
): ToolRegistryEntry {
  // Extract parameter names from the JSON Schema inputSchema
  const properties = (tool.inputSchema as any)?.properties || {};
  const params = Object.keys(properties);

  // Strip the serverName__ prefix to get the original MCP tool name
  const originalName = tool.name.replace(`${tool.serverName}__`, "");

  return {
    definition: {
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
    },
    handler: {
      name: tool.name,
      params,
      execute: async (...args: any[]) => {
        // Last arg is the internal context object that prompt.ts appends — strip it
        const actualArgs = args.slice(0, params.length);
        const argsObj: Record<string, unknown> = {};
        params.forEach((p, i) => {
          argsObj[p] = actualArgs[i];
        });
        return callTool(tool.serverName, originalName, argsObj);
      },
      isBuiltin: false,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/runtime/mcp/toolAdapter.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/mcp/toolAdapter.ts lib/runtime/mcp/toolAdapter.test.ts
git commit -m "feat: add MCP tool-to-registry-entry adapter"
```

---

### Task 7: Integrate McpManager into RuntimeContext

**Files:**
- Modify: `lib/runtime/state/context.ts`
- Modify: `lib/runtime/node.ts` (cleanup path)

**Context:** `McpManager` needs to live on `RuntimeContext` and be shared across parallel execution contexts. It also needs to be torn down in the cleanup path.

**Docs to check:** Read `lib/runtime/state/context.ts` for `createExecutionContext()` (line 136) and `cleanup()` (line 253). Read `lib/runtime/node.ts` line 202-203 for the `finally` block.

- [ ] **Step 1: Add McpManager to RuntimeContext**

In `lib/runtime/state/context.ts`:

1. Import `McpManager`:
```ts
import { McpManager } from "../mcp/mcpManager.js";
import type { McpServerConfig } from "../mcp/types.js";
```

2. Add the property to the class:
```ts
mcpManager: McpManager;
```

3. In the constructor, initialize with an empty config (MCP config gets set later by generated code):
```ts
this.mcpManager = new McpManager({});
```

4. In `createExecutionContext()`, share the same instance:
```ts
execCtx.mcpManager = this.mcpManager;
```

5. In `lib/runtime/node.ts`, in the `finally` block of `runNode()` (around line 202), add `await execCtx.mcpManager.disconnectAll()` **before** `execCtx.cleanup()`. This ensures MCP connections are torn down properly before the context is nulled out:

```ts
} finally {
  await execCtx.mcpManager.disconnectAll();
  execCtx.cleanup();
}
```

This is the proper teardown path as specified in the spec. The `cleanup()` method remains synchronous.

- [ ] **Step 2: Run existing tests to ensure nothing broke**

Run: `pnpm test:run`
Expected: All tests pass. The `McpManager({})` with empty config is inert — it does nothing unless `getTools()` is called.

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/state/context.ts
git commit -m "feat: add McpManager to RuntimeContext"
```

---

### Task 8: Add `mcp` built-in function

**Files:**
- Modify: `lib/config.ts` — add `mcp` to `BUILTIN_FUNCTIONS`
- Create: `lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.mustache`
- Modify: `lib/backends/typescriptGenerator/builtins.ts` — import and render the mcp template
- Modify: `lib/runtime/index.ts` — export McpManager and types

**Context:** The `mcp()` built-in needs two things: (1) a mustache template that defines the runtime wrapper function, and (2) that template rendered into the generated code via `generateBuiltinHelpers()`.

Note on `BUILTIN_FUNCTIONS`: this record is currently empty and is used by `isBuiltinFunction()` and `mapFunctionName()` for name remapping. The existing builtins (`input`, `sleep`, etc.) are NOT registered in `BUILTIN_FUNCTIONS` — they're included unconditionally via `generateBuiltinHelpers()`. Adding `mcp` to `BUILTIN_FUNCTIONS` makes `isBuiltinFunction("mcp")` return true, which may be needed by other parts of the compiler. Check if any code path uses `isBuiltinFunction()` to decide how to compile function calls — if so, add it; if not, skip this step.

**Docs to check:** Look at `lib/templates/backends/typescriptGenerator/builtinFunctions/sleep.mustache` as a template example. Look at `lib/backends/typescriptGenerator/builtins.ts` to see how templates are imported and rendered. Search for uses of `isBuiltinFunction` to determine if registration is needed.

- [ ] **Step 1: Optionally add `mcp` to BUILTIN_FUNCTIONS in config.ts**

Check if `isBuiltinFunction()` is used anywhere in the compilation pipeline for function call handling. If it is, add `mcp` to the record. If not, skip this step — the template inclusion in step 4 is what actually matters.

```ts
export const BUILTIN_FUNCTIONS: Record<string, string> = {
  mcp: "mcp",
};
```

- [ ] **Step 2: Create the mustache template**

Create `lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.mustache`:

```
async function mcp(serverName: string) {
  return __ctx.mcpManager.getTools(serverName);
}
```

- [ ] **Step 3: Compile the mustache template**

Run: `pnpm run templates`
Expected: Generates `lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.ts`

- [ ] **Step 4: Add the template to builtins.ts**

In `lib/backends/typescriptGenerator/builtins.ts`, add:

```ts
import * as builtinFunctionsMcp from "../../templates/backends/typescriptGenerator/builtinFunctions/mcp.js";
```

And in `generateBuiltinHelpers()`, add:

```ts
const mcpFunc = builtinFunctionsMcp.default({});
helpers.push(mcpFunc);
```

- [ ] **Step 5: Export MCP types from runtime/index.ts**

In `lib/runtime/index.ts`, add exports so the generated code can access `McpManager`:

```ts
export { McpManager } from "./mcp/mcpManager.js";
export type { McpServerConfig, McpToolObject } from "./mcp/types.js";
```

- [ ] **Step 6: Build and verify**

Run: `make all`
Expected: Build succeeds

- [ ] **Step 7: Run existing tests**

Run: `pnpm test:run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add lib/config.ts lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.mustache lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.ts lib/backends/typescriptGenerator/builtins.ts lib/runtime/index.ts
git commit -m "feat: add mcp() built-in function"
```

---

### Task 9: Handle MCP tool objects in the tools array (prompt.ts + builder)

**Files:**
- Modify: `lib/runtime/prompt.ts`
- Modify: `lib/backends/typescriptBuilder.ts`

**Context:** Two changes are needed:

1. **prompt.ts** — When processing the `tools` array in `runPrompt()`, detect entries with `__mcpTool: true` and transform them into `{ definition, handler }` pairs using `mcpToolToRegistryEntry`. This must happen before the existing split into `tools` and `toolHandlers`.

2. **typescriptBuilder.ts** — The builder currently extracts tool names from the `tools` array in the LLM config (line 2556-2573) and only handles `variableName` and `functionCall` items. Spread expressions (type `splat`) in the tools array are silently dropped. The builder needs to pass through spread expressions as-is so that `...mcpTools` works. The spread values should be included in the generated `tools` array directly (not resolved via the tool registry).

- [ ] **Step 1: Update prompt.ts to handle MCP tool objects**

In `lib/runtime/prompt.ts`, at the top of `runPrompt()` where it processes `args.clientConfig?.tools`, add MCP tool detection. Import the helpers:

```ts
import { isMcpTool, mcpToolToRegistryEntry } from "./mcp/toolAdapter.js";
```

Replace the tool extraction logic (around lines 437-445) to handle both regular tools and MCP tools:

```ts
const rawTools = args.clientConfig?.tools || [];
const toolEntries: { definition: Tool; handler: ToolHandler }[] = rawTools.map(
  (entry: any) => {
    if (isMcpTool(entry)) {
      return mcpToolToRegistryEntry(entry, (serverName, toolName, toolArgs) =>
        ctx.mcpManager.callTool(serverName, toolName, toolArgs),
      );
    }
    return entry;
  },
);
```

- [ ] **Step 2: Update the builder to pass through spread expressions in the tools array**

In `lib/backends/typescriptBuilder.ts`, around line 2556-2573, the code iterates `toolsEntry.value.items` and only handles `variableName` and `functionCall` types — `splat` items are silently dropped. Modify the loop to also collect splat items as pass-through expressions.

Add a new array alongside `configToolNames`:

```ts
const configToolExprs: TsNode[] = [];
```

In the loop over `toolsEntry.value.items`, add a case for splats:

```ts
if (item.type === "splat") {
  // Pass-through: spread MCP tool arrays (or any other spread) directly
  configToolExprs.push(ts.spread(this.processNode(item.value)));
}
```

Then, around line 2604-2609 where `toolNodes` is built, merge both lists:

```ts
const toolNodes: TsNode[] = allToolNames.map((name) =>
  $(ts.id("tool")).call([ts.str(name)]).done(),
);
// Merge registry-resolved tools with pass-through expressions (spreads)
const allToolNodes: TsNode[] = [...toolNodes, ...configToolExprs];
```

Update the merged config (around line 2613-2621) to use `allToolNodes` instead of `toolNodes`. The condition for whether to add the tools key should check `allToolNodes.length > 0` instead of `allToolNames.length > 0`:

```ts
if (allToolNodes.length > 0) {
  mergedConfig = ts.obj([
    ts.set("tools", ts.arr(allToolNodes)),
    ts.setSpread(clientConfig),
  ]);
} else {
  mergedConfig = clientConfig;
}
```

- [ ] **Step 3: Run existing tests**

Run: `pnpm test:run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/prompt.ts lib/backends/typescriptBuilder.ts
git commit -m "feat: handle MCP tool objects in prompt.ts and pass-through spreads in builder"
```

---

### Task 10: Wire MCP config into generated code

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (in `generateImports()`)

**Context:** The `McpManager` on `__globalCtx` needs to be initialized with the actual MCP server config from `agency.json`. Currently it's initialized with `{}`. The builder has access to `this.agencyConfig` and needs to generate code that sets the MCP config on `__globalCtx.mcpManager`.

- [ ] **Step 1: Update generateImports to include MCP config**

In `lib/backends/typescriptBuilder.ts`, in the `generateImports()` method, after the `__globalCtx` is created (around line 3304), generate an assignment that sets the MCP config. This avoids changing the `RuntimeContext` constructor signature.

After the existing `ts.constDecl("__globalCtx", ...)` and `ts.constDecl("graph", ...)` statements, add:

```ts
if (this.agencyConfig.mcpServers) {
  // Generate: __globalCtx.mcpManager = new McpManager(<config>);
  const mcpConfig = ts.raw(JSON.stringify(this.agencyConfig.mcpServers));
  runtimeCtx = ts.statements([
    runtimeCtx,
    ts.raw(`__globalCtx.mcpManager = new McpManager(${JSON.stringify(this.agencyConfig.mcpServers)});`),
  ]);
}
```

Also add `McpManager` to the import list in `imports.mustache`:

```ts
import { McpManager } from "agency-lang/runtime";
```

This generates code like:
```ts
const __globalCtx = new RuntimeContext({...});
const graph = __globalCtx.graph;
__globalCtx.mcpManager = new McpManager({"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}});
```

- [ ] **Step 2: Build and verify**

Run: `make all`
Expected: Build succeeds

- [ ] **Step 3: Run existing tests**

Run: `pnpm test:run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "feat: wire MCP server config from agency.json into generated code"
```

---

### Task 11: End-to-end integration test

**Files:**
- Create: `lib/runtime/mcp/mcp.integration.test.ts`

**Context:** Test the full flow: compile an Agency file that uses `mcp()`, verify it generates correct code, and if possible run it against the test MCP server.

The simplest approach: use the existing integration test patterns. Write a test that creates a `McpManager` with the test server config, calls `getTools()`, then passes the tools through `mcpToolToRegistryEntry`, and verifies the tool can be called.

- [ ] **Step 1: Write the integration test**

Create `lib/runtime/mcp/mcp.integration.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { McpManager } from "./mcpManager.js";
import { isMcpTool, mcpToolToRegistryEntry } from "./toolAdapter.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

describe("MCP integration", () => {
  let manager: McpManager;

  afterEach(async () => {
    if (manager) {
      await manager.disconnectAll();
    }
  });

  it("full flow: getTools -> detect MCP tool -> convert to registry entry -> call tool", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    // Step 1: Get tools (returns Result)
    const result = await manager.getTools("test");
    expect(result.success).toBe(true);

    const tools = result.value;
    expect(tools.length).toBeGreaterThan(0);

    // Step 2: Verify they're MCP tools
    const addTool = tools.find((t: any) => t.name === "test__add");
    expect(addTool).toBeDefined();
    expect(isMcpTool(addTool)).toBe(true);

    // Step 3: Convert to registry entry
    const entry = mcpToolToRegistryEntry(addTool!, (serverName, toolName, args) =>
      manager.callTool(serverName, toolName, args),
    );

    expect(entry.definition.name).toBe("test__add");
    expect(entry.handler.params).toContain("a");
    expect(entry.handler.params).toContain("b");

    // Step 4: Call the tool through the handler
    // prompt.ts appends a context object as the last arg — simulate that
    const toolResult = await entry.handler.execute(3, 4, { ctx: null, threads: null, isToolCall: true });
    expect(toolResult).toContain("7");
  });

  it("tools survive JSON serialization round-trip", async () => {
    manager = new McpManager({
      test: {
        command: "npx",
        args: ["tsx", TEST_SERVER_PATH],
      },
    });

    const result = await manager.getTools("test");
    expect(result.success).toBe(true);

    const tools = result.value;
    const serialized = JSON.stringify(tools);
    const deserialized = JSON.parse(serialized);

    // Verify shape is preserved
    expect(deserialized[0].__mcpTool).toBe(true);
    expect(deserialized[0].serverName).toBe("test");
    expect(deserialized[0].name).toBe("test__add");

    // Verify we can still create a registry entry from deserialized data
    const entry = mcpToolToRegistryEntry(deserialized[0], (serverName, toolName, args) =>
      manager.callTool(serverName, toolName, args),
    );
    const toolResult = await entry.handler.execute(3, 4, { ctx: null });
    expect(toolResult).toContain("7");
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm vitest run lib/runtime/mcp/mcp.integration.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run all tests to ensure nothing is broken**

Run: `pnpm test:run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/mcp/mcp.integration.test.ts
git commit -m "test: add MCP end-to-end integration test"
```

---

### Task 12: Final cleanup and verification

**Files:**
- No new files

- [ ] **Step 1: Build everything**

Run: `make all`
Expected: Clean build

- [ ] **Step 2: Run all tests**

Run: `pnpm test:run`
Expected: All tests pass

- [ ] **Step 3: Verify a manual test compiles**

Create a temporary test file to verify compilation works. Create `test-mcp.agency` in the project root:

```ts
node main() {
  const tools = mcp("test") catch []
  print(tools)
}
```

Run: `pnpm run compile test-mcp.agency`
Expected: Compiles successfully. The generated TypeScript should contain the `mcp()` wrapper function and the call should reference `__ctx.mcpManager.getTools("test")`.

Inspect the generated output to verify:
1. The `mcp` function is defined in the generated code
2. It calls `__ctx.mcpManager.getTools`
3. The `catch` is compiled correctly (wrapping the result)

Then delete the test file.

- [ ] **Step 4: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: final cleanup for MCP support"
```
