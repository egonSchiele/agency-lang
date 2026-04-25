# MCP Package Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all MCP functionality from the main `agency-lang` package into a separate `@agency-lang/mcp` package at `packages/mcp/`.

**Architecture:** Move MCP runtime code (McpManager, OAuth, TokenStore, toolAdapter, types) into a new npm package. The package exports an `mcp()` Agency function that reads `agency.json` itself, manages a singleton McpManager, and returns `AgencyFunction[]` directly. The main package removes all MCP code, the `mcp()` builtin, and the `@modelcontextprotocol/sdk` dependency.

**Tech Stack:** TypeScript, Agency language, `@modelcontextprotocol/sdk`, Zod, pnpm workspace

**Spec:** `docs/superpowers/specs/2026-04-25-mcp-package-extraction-design.md`

---

## File Structure

### New files (packages/mcp/)

| File | Responsibility |
|------|---------------|
| `packages/mcp/package.json` | Package manifest with deps, bin entry, agency entrypoint |
| `packages/mcp/tsconfig.json` | TypeScript config for the package |
| `packages/mcp/index.agency` | Exports `mcp()` Agency function |
| `packages/mcp/src/mcp.ts` | Singleton McpManager, config reading, `mcp()` implementation that returns `AgencyFunction[]` |
| `packages/mcp/src/mcpManager.ts` | Moved from `lib/runtime/mcp/mcpManager.ts` |
| `packages/mcp/src/mcpConnection.ts` | Moved from `lib/runtime/mcp/mcpConnection.ts` |
| `packages/mcp/src/oauthConnector.ts` | Moved from `lib/runtime/mcp/oauthConnector.ts` |
| `packages/mcp/src/oauthProvider.ts` | Moved from `lib/runtime/mcp/oauthProvider.ts` |
| `packages/mcp/src/callbackServer.ts` | Moved from `lib/runtime/mcp/callbackServer.ts` |
| `packages/mcp/src/tokenStore.ts` | Moved from `lib/runtime/mcp/tokenStore.ts` |
| `packages/mcp/src/toolAdapter.ts` | Moved from `lib/runtime/mcp/toolAdapter.ts` |
| `packages/mcp/src/types.ts` | Moved from `lib/runtime/mcp/types.ts` |
| `packages/mcp/src/configReader.ts` | Reads and validates `mcpServers` from `agency.json` |
| `packages/mcp/src/cli.ts` | CLI entry point for `npx @agency-lang/mcp auth` |
| `packages/mcp/tests/` | Moved MCP unit tests |

### Deleted files

| File | Reason |
|------|--------|
| `lib/runtime/mcp/mcpManager.ts` | Moved to package |
| `lib/runtime/mcp/mcpConnection.ts` | Moved to package |
| `lib/runtime/mcp/oauthConnector.ts` | Moved to package |
| `lib/runtime/mcp/oauthProvider.ts` | Moved to package |
| `lib/runtime/mcp/callbackServer.ts` | Moved to package |
| `lib/runtime/mcp/tokenStore.ts` | Moved to package |
| `lib/runtime/mcp/toolAdapter.ts` | Moved to package |
| `lib/runtime/mcp/types.ts` | Moved to package |
| `lib/runtime/mcp/*.test.ts` | Moved to package |
| `lib/runtime/mcp/__tests__/` | Moved to package |
| `lib/cli/auth.ts` | Moved to package |
| `lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.mustache` | Builtin removed |
| `lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.ts` | Generated from mustache, removed |

### Modified files

| File | Change |
|------|--------|
| `lib/config.ts` | Remove `McpServerConfig` import, `mcpServers` from interface, MCP Zod schemas |
| `lib/runtime/state/context.ts` | Remove McpManager import, field, constructor init, `createMcpManager()`, `disconnectMcp()`, shared state assignment |
| `lib/runtime/prompt.ts` | Remove MCP tool detection/conversion, simplify to AgencyFunction-only |
| `lib/backends/typescriptBuilder.ts` | Remove `"mcp"` from `DIRECT_CALL_FUNCTIONS`, remove MCP config block in `buildRuntimeContext()` |
| `lib/backends/typescriptGenerator/builtins.ts` | Remove mcp import and generation |
| `lib/runtime/index.ts` | Remove MCP exports |
| `scripts/agency.ts` | Remove `agency auth` command and its import |
| `package.json` | Remove `@modelcontextprotocol/sdk` dependency |
| `pnpm-workspace.yaml` | Add `packages/*` (create if needed) |

---

## Task 1: Set Up Package Scaffold

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`
- Create: `pnpm-workspace.yaml` (or modify if exists)

- [ ] **Step 1: Create pnpm workspace config**

Check if `pnpm-workspace.yaml` exists at the repo root. If not, create it:

```yaml
packages:
  - "packages/*"
```

If it already exists, add `"packages/*"` to the `packages` array.

- [ ] **Step 2: Create packages/mcp/package.json**

```json
{
  "name": "@agency-lang/mcp",
  "version": "0.0.1",
  "description": "MCP (Model Context Protocol) support for the Agency language",
  "type": "module",
  "agency": "./index.agency",
  "main": "./dist/src/mcp.js",
  "exports": {
    ".": {
      "import": "./dist/src/mcp.js",
      "types": "./dist/src/mcp.d.ts"
    },
    "./package.json": "./package.json"
  },
  "bin": {
    "@agency-lang/mcp": "./dist/src/cli.js"
  },
  "files": [
    "dist/",
    "index.agency"
  ],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0"
  },
  "peerDependencies": {
    "agency-lang": "*",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Create packages/mcp/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Run pnpm install to set up workspace links**

Run: `pnpm install`
Expected: workspace resolves, `packages/mcp/node_modules` is populated.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml packages/mcp/package.json packages/mcp/tsconfig.json
git commit -m "scaffold @agency-lang/mcp package"
```

---

## Task 2: Move MCP Runtime Code to Package

**Files:**
- Create: `packages/mcp/src/types.ts` (from `lib/runtime/mcp/types.ts`)
- Create: `packages/mcp/src/tokenStore.ts` (from `lib/runtime/mcp/tokenStore.ts`)
- Create: `packages/mcp/src/callbackServer.ts` (from `lib/runtime/mcp/callbackServer.ts`)
- Create: `packages/mcp/src/oauthProvider.ts` (from `lib/runtime/mcp/oauthProvider.ts`)
- Create: `packages/mcp/src/oauthConnector.ts` (from `lib/runtime/mcp/oauthConnector.ts`)
- Create: `packages/mcp/src/mcpConnection.ts` (from `lib/runtime/mcp/mcpConnection.ts`)
- Create: `packages/mcp/src/mcpManager.ts` (from `lib/runtime/mcp/mcpManager.ts`)
- Create: `packages/mcp/src/toolAdapter.ts` (from `lib/runtime/mcp/toolAdapter.ts`)

- [ ] **Step 1: Copy all MCP runtime files to packages/mcp/src/**

Copy each file from `lib/runtime/mcp/` to `packages/mcp/src/`. The files to copy are:
- `types.ts`
- `tokenStore.ts`
- `callbackServer.ts`
- `oauthProvider.ts`
- `oauthConnector.ts`
- `mcpConnection.ts`
- `mcpManager.ts`
- `toolAdapter.ts`

- [ ] **Step 2: Update import paths in copied files**

All inter-file imports within `lib/runtime/mcp/` use relative paths like `"./types.js"` — these stay the same since the files are in the same directory.

Imports that reference the main `agency-lang` package need to change. These are:

In `toolAdapter.ts`:
- `import { AgencyFunction } from "../agencyFunction.js"` → `import { AgencyFunction } from "agency-lang/runtime"`

In `mcpManager.ts`:
- `import { success, failure, type ResultValue } from "../result.js"` → `import { success, failure, type ResultValue } from "agency-lang/runtime"`

Check each copied file for any other imports starting with `"../"` that reference the main package's runtime. All such imports should be updated to import from `"agency-lang/runtime"` (or the appropriate export path — verify what `agency-lang` exports by checking `lib/runtime/index.ts`).

**Important:** If `agency-lang` does not export `AgencyFunction` or `success`/`failure` from a public path, you may need to add those exports. Check `lib/runtime/index.ts` and the package.json `exports` field to see what's available.

- [ ] **Step 3: Verify the package compiles**

Run: `cd packages/mcp && npx tsc --noEmit`
Expected: No errors. Fix any remaining import issues.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/
git commit -m "move MCP runtime files to @agency-lang/mcp package"
```

---

## Task 3: Move MCP Tests to Package

**Files:**
- Create: `packages/mcp/tests/` (from `lib/runtime/mcp/*.test.ts` and `lib/runtime/mcp/__tests__/`)

- [ ] **Step 1: Copy test files**

Copy all `*.test.ts` files from `lib/runtime/mcp/` to `packages/mcp/tests/`:
- `callbackServer.test.ts`
- `mcpManager.test.ts`
- `mcpConnection.test.ts`
- `toolAdapter.test.ts`
- `tokenStore.test.ts`
- `oauthProvider.test.ts`
- `oauthConnector.test.ts`
- `mcp.integration.test.ts`

Also copy `lib/runtime/mcp/__tests__/testServer.ts` to `packages/mcp/tests/__tests__/testServer.ts`.

- [ ] **Step 2: Update import paths in test files**

All test file imports that reference `"../mcpManager.js"` etc. need to be updated to `"../src/mcpManager.js"` (relative to the tests dir). Imports from the main agency-lang runtime need to point to `"agency-lang/runtime"`.

- [ ] **Step 3: Create vitest config**

Create `packages/mcp/vitest.config.ts` if needed, or rely on the root vitest config. Verify tests run:

Run: `cd packages/mcp && pnpm test`
Expected: All MCP tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/tests/
git commit -m "move MCP tests to @agency-lang/mcp package"
```

---

## Task 4: Create Config Reader

**Files:**
- Create: `packages/mcp/src/configReader.ts`

The config reader is responsible for finding `agency.json`, parsing it, and extracting+validating the `mcpServers` section. This logic currently lives in `lib/config.ts` (the MCP Zod schemas at lines 164-300).

- [ ] **Step 1: Write test for config reader**

Create `packages/mcp/tests/configReader.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { readMcpConfig } from "../src/configReader.js";

describe("readMcpConfig", () => {
  it("reads mcpServers from agency.json", () => {
    // Test with a mock filesystem or temp file
    // Should return the parsed mcpServers config
  });

  it("returns empty object when no mcpServers configured", () => {
    // agency.json exists but has no mcpServers key
  });

  it("returns empty object when no agency.json found", () => {
    // No agency.json in the directory tree
  });

  it("validates stdio server config", () => {
    // Valid stdio config should pass
  });

  it("validates http server config", () => {
    // Valid http config should pass
  });

  it("rejects invalid config (auth + headers)", () => {
    // Should throw/return error
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mcp && pnpm test -- configReader`
Expected: FAIL — `readMcpConfig` not found.

- [ ] **Step 3: Implement configReader.ts**

Create `packages/mcp/src/configReader.ts`. This file:

1. Exports `readMcpConfig(cwd?: string): Record<string, McpServerConfig>`.
2. Walks up from `cwd` (default `process.cwd()`) looking for `agency.json`.
3. If found, parses JSON, extracts `mcpServers` key.
4. Validates using Zod schemas (move the `McpStdioServerSchema`, `McpHttpServerSchema`, `McpServerSchema` definitions and the `superRefine` validation from `lib/config.ts` lines 164-300 into this file).
5. Returns the validated config object, or `{}` if no config or no `mcpServers` key.

```typescript
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import type { McpServerConfig } from "./types.js";

const McpStdioServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const McpHttpServerSchema = z
  .object({
    type: z.literal("http"),
    url: z.string(),
    auth: z.literal("oauth").optional(),
    authTimeout: z.number().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const McpServerSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);

const McpServersSchema = z
  .record(
    z
      .string()
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "MCP server names must contain only letters, numbers, hyphens, and underscores",
      ),
    McpServerSchema,
  )
  .superRefine((data, ctx) => {
    for (const [name, server] of Object.entries(data)) {
      if ("type" in server && server.type === "http") {
        const httpServer = server as z.infer<typeof McpHttpServerSchema>;
        if (httpServer.auth && httpServer.headers) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP server "${name}": cannot specify both 'auth' and 'headers'`,
            path: [name],
          });
        }
        if (httpServer.authTimeout && httpServer.auth !== "oauth") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP server "${name}": 'authTimeout' requires 'auth: "oauth"'`,
            path: [name],
          });
        }
        if (httpServer.clientId && httpServer.auth !== "oauth") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP server "${name}": 'clientId' requires 'auth: "oauth"'`,
            path: [name],
          });
        }
        if (httpServer.clientSecret && httpServer.auth !== "oauth") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP server "${name}": 'clientSecret' requires 'auth: "oauth"'`,
            path: [name],
          });
        }
        if (httpServer.auth === "oauth") {
          try {
            const parsed = new URL(httpServer.url);
            const isLocalhost = ["127.0.0.1", "localhost"].includes(parsed.hostname);
            if (parsed.protocol !== "https:" && !isLocalhost) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `MCP server "${name}": OAuth requires HTTPS (or localhost for development)`,
                path: [name, "url"],
              });
            }
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `MCP server "${name}": invalid URL "${httpServer.url}"`,
              path: [name, "url"],
            });
          }
        }
      }
    }
  });

function findAgencyJson(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, "agency.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readMcpConfig(cwd?: string): Record<string, McpServerConfig> {
  const jsonPath = findAgencyJson(cwd || process.cwd());
  if (!jsonPath) return {};

  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  if (!raw.mcpServers) return {};

  const result = McpServersSchema.parse(raw.mcpServers);
  return result as Record<string, McpServerConfig>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/mcp && pnpm test -- configReader`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/configReader.ts packages/mcp/tests/configReader.test.ts
git commit -m "add config reader for @agency-lang/mcp"
```

---

## Task 5: Create the mcp() Function

**Files:**
- Create: `packages/mcp/src/mcp.ts`

This is the core file — it implements the singleton McpManager pattern and the `mcp()` function that returns `AgencyFunction[]`.

- [ ] **Step 1: Write test for mcp()**

Create `packages/mcp/tests/mcp.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Tests should verify:
// 1. mcp() creates a singleton McpManager on first call
// 2. mcp() returns AgencyFunction[] (not McpTool[])
// 3. Subsequent calls reuse the same manager
// 4. Each returned AgencyFunction has a toolDefinition
// 5. Calling the AgencyFunction routes to mcpManager.callTool
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mcp && pnpm test -- mcp.test`
Expected: FAIL

- [ ] **Step 3: Implement mcp.ts**

Create `packages/mcp/src/mcp.ts`:

```typescript
import { McpManager } from "./mcpManager.js";
import { mcpToolToAgencyFunction } from "./toolAdapter.js";
import { readMcpConfig } from "./configReader.js";
import type { McpServerConfig } from "./types.js";
import { success, failure } from "agency-lang/runtime";
import type { ResultValue } from "agency-lang/runtime";

let singleton: McpManager | null = null;
let loadedConfig: Record<string, McpServerConfig> | null = null;

function getManager(onOAuthRequired?: (data: any) => void | Promise<void>): McpManager {
  if (!singleton) {
    loadedConfig = readMcpConfig();
    singleton = new McpManager(loadedConfig, { onOAuthRequired });
    process.on("beforeExit", async () => {
      if (singleton) {
        await singleton.disconnectAll();
        singleton = null;
      }
    });
  }
  return singleton;
}

export async function mcp(
  serverName: string,
  onOAuthRequired?: (data: any) => void | Promise<void>,
): Promise<ResultValue> {
  const manager = getManager(onOAuthRequired);
  const result = await manager.getTools(serverName);

  // If failure, return as-is
  if (!result.success) {
    return result;
  }

  // Convert McpTool[] to AgencyFunction[]
  const tools = result.value;
  const agencyFunctions = tools.map((tool: any) =>
    mcpToolToAgencyFunction(tool, (sn, tn, args) =>
      manager.callTool(sn, tn, args),
    ),
  );

  return success(agencyFunctions);
}

// Re-export types for TypeScript consumers
export type { McpTool, McpServerConfig } from "./types.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/mcp && pnpm test -- mcp.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/mcp.ts packages/mcp/tests/mcp.test.ts
git commit -m "implement mcp() function with singleton McpManager"
```

---

## Task 6: Create the Agency Entrypoint

**Files:**
- Create: `packages/mcp/index.agency`

- [ ] **Step 1: Create index.agency**

This file is the Agency-language entrypoint that wraps the TypeScript `mcp()` function. Users import from this via `pkg::@agency-lang/mcp`.

```
import { mcp } from "./dist/src/mcp.js"

export def mcp(serverName: string, onOAuthRequired?: any) {
  return mcp(serverName, onOAuthRequired)
}
```

**Note:** The exact syntax here depends on how Agency handles re-exporting imported functions. If Agency supports direct re-export, use that instead. If there's a naming conflict with the imported `mcp` and the exported `def mcp`, rename the import:

```
import { mcp as mcpImpl } from "./dist/src/mcp.js"

export def mcp(serverName: string) {
  return mcpImpl(serverName)
}
```

Check how other Agency packages handle this pattern. The key requirement: when a user writes `import { mcp } from "pkg::@agency-lang/mcp"`, they get a callable `mcp()` function.

- [ ] **Step 2: Verify the Agency file parses**

Run: `pnpm run ast packages/mcp/index.agency`
Expected: Valid AST output (no parse errors).

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/index.agency
git commit -m "add Agency entrypoint for @agency-lang/mcp"
```

---

## Task 7: Create CLI for Auth Commands

**Files:**
- Create: `packages/mcp/src/cli.ts` (from `lib/cli/auth.ts`)

- [ ] **Step 1: Copy lib/cli/auth.ts to packages/mcp/src/cli.ts**

The CLI file needs to be a standalone executable. Adapt `lib/cli/auth.ts` into a CLI entry point:

```typescript
#!/usr/bin/env node

import { readMcpConfig } from "./configReader.js";
import { OAuthConnector } from "./oauthConnector.js";
import { TokenStore } from "./tokenStore.js";
import { isOAuthServer } from "./types.js";
import type { McpHttpServerConfig } from "./types.js";

const args = process.argv.slice(2);

async function main() {
  if (args.includes("--list")) {
    await listAuth();
  } else if (args.includes("--revoke")) {
    const idx = args.indexOf("--revoke");
    const serverName = args[idx + 1];
    if (!serverName) {
      console.error("Usage: @agency-lang/mcp auth --revoke <server-name>");
      process.exit(1);
    }
    await revokeAuth(serverName);
  } else if (args[0] === "auth" && args[1]) {
    await authServer(args[1]);
  } else {
    console.error("Usage: @agency-lang/mcp auth <server-name> | --list | --revoke <server-name>");
    process.exit(1);
  }
}

async function authServer(serverName: string) {
  const config = readMcpConfig();
  if (!config[serverName]) {
    console.error(`Server "${serverName}" not found in agency.json mcpServers config.`);
    process.exit(1);
  }
  if (!isOAuthServer(config[serverName])) {
    console.error(`Server "${serverName}" does not use OAuth authentication.`);
    process.exit(1);
  }
  const httpConfig = config[serverName] as McpHttpServerConfig;
  const connector = new OAuthConnector(serverName, httpConfig.url, new TokenStore(), {
    timeoutMs: httpConfig.authTimeout,
    clientId: httpConfig.clientId,
    clientSecret: httpConfig.clientSecret,
  });
  console.log(`Authenticating with "${serverName}"...`);
  await connector.connect();
  console.log(`Successfully authenticated with "${serverName}".`);
}

async function listAuth() {
  const store = new TokenStore();
  const servers = await store.listServers();
  if (servers.length === 0) {
    console.log("No stored OAuth tokens.");
    return;
  }
  for (const name of servers) {
    const tokens = await store.loadTokens(name);
    const hasRefresh = tokens?.refresh_token ? "yes" : "no";
    console.log(`  ${name} (refresh token: ${hasRefresh})`);
  }
}

async function revokeAuth(serverName: string) {
  const store = new TokenStore();
  await store.deleteTokens(serverName);
  console.log(`Revoked token for "${serverName}".`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
```

Adapt the actual implementation from `lib/cli/auth.ts` — the above is a sketch. The key changes from the original:
- Uses `readMcpConfig()` instead of the main package's `getConfig()`
- No dependency on the main CLI framework (commander)
- Standalone entry point with `#!/usr/bin/env node`

- [ ] **Step 2: Verify the CLI compiles**

Run: `cd packages/mcp && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/src/cli.ts
git commit -m "add CLI entry point for auth commands"
```

---

## Task 8: Remove MCP From Main Package — Runtime

**Files:**
- Delete: `lib/runtime/mcp/` (entire directory)
- Modify: `lib/runtime/state/context.ts`
- Modify: `lib/runtime/prompt.ts`
- Modify: `lib/runtime/index.ts`

- [ ] **Step 1: Remove MCP from RuntimeContext**

In `lib/runtime/state/context.ts`:

Remove the import (line 19):
```typescript
// DELETE: import { McpManager } from "../mcp/mcpManager.js";
```

Remove the field (line 80):
```typescript
// DELETE: private _mcpManager: McpManager;
```

Remove from constructor (line 139):
```typescript
// DELETE: this._mcpManager = new McpManager({});
```

Remove from `createExecutionContext` (line 180):
```typescript
// DELETE: execCtx._mcpManager = this._mcpManager;
```

Remove the MCP methods (lines 370-383):
```typescript
// DELETE: createMcpManager(config: Record<string, any>): void { ... }
// DELETE: get mcpManager(): McpManager { ... }
// DELETE: async disconnectMcp(): Promise<void> { ... }
```

- [ ] **Step 2: Remove MCP tool detection from prompt.ts**

In `lib/runtime/prompt.ts`:

Remove the import (line 23):
```typescript
// DELETE: import { isMcpTool, mcpToolToAgencyFunction } from "./mcp/toolAdapter.js";
```

Replace the tool normalization block (lines 434-450) with simpler logic:

```typescript
  // Tools array contains AgencyFunction instances only.
  const rawTools: any[] = args.clientConfig?.tools || [];
  const agencyFunctions: AgencyFunction[] = rawTools.map((entry: any) => {
    if (!AgencyFunction.isAgencyFunction(entry)) {
      const receivedType = entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry;
      throw new TypeError(
        `Invalid tool in clientConfig.tools. Expected an AgencyFunction instance, but received ${receivedType}.`,
      );
    }
    return entry;
  });
```

- [ ] **Step 3: Remove MCP exports from runtime index**

In `lib/runtime/index.ts`, remove lines 107-108:
```typescript
// DELETE: export { McpManager } from "./mcp/mcpManager.js";
// DELETE: export type { McpServerConfig, McpTool } from "./mcp/types.js";
```

- [ ] **Step 4: Delete lib/runtime/mcp/ directory**

Remove the entire `lib/runtime/mcp/` directory:

Run: `rm -rf lib/runtime/mcp/`

- [ ] **Step 5: Delete lib/cli/auth.ts**

Run: `rm lib/cli/auth.ts`

- [ ] **Step 6: Verify the main package compiles**

Run: `pnpm run build`
Expected: May fail — other files may still reference MCP. Fix in next steps.

- [ ] **Step 7: Commit**

```bash
git add -A lib/runtime/mcp/ lib/runtime/state/context.ts lib/runtime/prompt.ts lib/runtime/index.ts lib/cli/auth.ts
git commit -m "remove MCP runtime code from main package"
```

---

## Task 9: Remove MCP From Main Package — Compiler and Config

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`
- Modify: `lib/backends/typescriptGenerator/builtins.ts`
- Delete: `lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.mustache`
- Delete: `lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.ts`
- Modify: `lib/config.ts`

- [ ] **Step 1: Remove "mcp" from DIRECT_CALL_FUNCTIONS**

In `lib/backends/typescriptBuilder.ts` line 342, change:

```typescript
"isSuccess", "isFailure", "mcp", "setLLMClient"
```

to:

```typescript
"isSuccess", "isFailure", "setLLMClient"
```

- [ ] **Step 2: Remove MCP config block from buildRuntimeContext()**

In `lib/backends/typescriptBuilder.ts`, delete lines 3318-3333 (the `if (this.agencyConfig.mcpServers)` block):

```typescript
// DELETE this entire block:
    if (this.agencyConfig.mcpServers) {
      const sanitizedServers = Object.fromEntries(
        Object.entries(this.agencyConfig.mcpServers).map(([name, cfg]) => {
          if ("type" in cfg && cfg.type === "http") {
            const { clientSecret, clientId, ...rest } = cfg as Record<string, any>;
            return [name, rest];
          }
          return [name, cfg];
        }),
      );
      runtimeCtxStatements.push(
        ts.raw(`__globalCtx.createMcpManager(${JSON.stringify(sanitizedServers)});`),
      );
    }
```

- [ ] **Step 3: Remove mcp builtin from builtins.ts**

In `lib/backends/typescriptGenerator/builtins.ts`:

Remove the import (line 8):
```typescript
// DELETE: import * as builtinFunctionsMcp from "../../templates/backends/typescriptGenerator/builtinFunctions/mcp.js";
```

Remove the generation (lines 59-60):
```typescript
// DELETE: const mcpFunc = builtinFunctionsMcp.default({});
// DELETE: helpers.push(mcpFunc);
```

- [ ] **Step 4: Delete mcp.mustache and generated mcp.ts**

Run:
```bash
rm lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.mustache
rm lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.ts
```

- [ ] **Step 5: Remove MCP config from lib/config.ts**

In `lib/config.ts`:

Remove the import (line 3):
```typescript
// DELETE: import type { McpServerConfig } from "./runtime/mcp/types.js";
```

Remove from the `AgencyConfig` interface (lines 158-159):
```typescript
// DELETE:   /** MCP server configurations */
// DELETE:   mcpServers?: Record<string, McpServerConfig>;
```

Remove the MCP Zod schemas (lines 164-184 — `McpStdioServerSchema`, `McpHttpServerSchema`, `McpServerSchema`).

Remove `mcpServers` from `AgencyConfigSchema` (lines 232-240):
```typescript
// DELETE:     mcpServers: z.record(
// DELETE:       z.string().regex(...),
// DELETE:       McpServerSchema,
// DELETE:     ),
```

Remove the MCP validation in `superRefine` (lines 245-299 — the entire `if (!data.mcpServers) return;` block and its contents).

- [ ] **Step 6: Verify the main package compiles**

Run: `pnpm run build`
Expected: PASS — no MCP references remain.

- [ ] **Step 7: Run templates to regenerate (since we deleted a mustache file)**

Run: `pnpm run templates`
Expected: Templates rebuild without the mcp template.

- [ ] **Step 8: Commit**

```bash
git add -A lib/backends/ lib/templates/ lib/config.ts
git commit -m "remove MCP from compiler, config, and builtins"
```

---

## Task 10: Remove MCP From CLI

**Files:**
- Modify: `scripts/agency.ts`
- Modify: `package.json`

- [ ] **Step 1: Remove auth import and command from scripts/agency.ts**

Remove the import (line 41):
```typescript
// DELETE: import { authServer, listAuth, revokeAuth } from "@/cli/auth.js";
```

Remove the `agency auth` command definition (lines 601-625):
```typescript
// DELETE: program
// DELETE:   .command("auth [server-name]")
// DELETE:   .description("Manage OAuth tokens for MCP servers")
// DELETE:   ... (entire block through closing paren and semicolon)
```

- [ ] **Step 2: Remove @modelcontextprotocol/sdk from package.json**

Remove `"@modelcontextprotocol/sdk": "^1.29.0"` from the `dependencies` section in `package.json`.

- [ ] **Step 3: Run pnpm install to update lockfile**

Run: `pnpm install`
Expected: Lockfile updated, MCP SDK removed from main package's deps.

- [ ] **Step 4: Verify full build and tests**

Run: `pnpm run build && pnpm test:run`
Expected: Build passes. Tests pass (MCP tests are no longer in the main package).

Some existing tests may fail if they were testing MCP integration from the main package perspective. Check for:
- Tests in `tests/agency-js/mcp/`
- Tests in `tests/agency-js/mcp-tool-call/`
- Tests in `tests/agency-js/mcp-catch-failure/`

These agency test files use `mcp()` as a builtin. They need to be updated to import from the package instead (or moved to the MCP package's test suite). Update them to add the import line:
```
import { mcp } from "pkg::@agency-lang/mcp"
```

- [ ] **Step 5: Commit**

```bash
git add scripts/agency.ts package.json pnpm-lock.yaml
git commit -m "remove MCP dependency and auth CLI from main package"
```

---

## Task 11: Update Agency Test Fixtures

**Files:**
- Modify: `tests/agency-js/mcp/agent.agency`
- Modify: `tests/agency-js/mcp-tool-call/agent.agency`
- Modify: `tests/agency-js/mcp-catch-failure/agent.agency`
- Modify: Corresponding `.mts` fixture files if they exist

- [ ] **Step 1: Update agency test files to import mcp from package**

For each `.agency` test file that uses `mcp()`, add the import line at the top:

```
import { mcp } from "pkg::@agency-lang/mcp"
```

- [ ] **Step 2: Rebuild fixtures**

Run: `make fixtures`
Expected: Fixtures regenerated with the new import in compiled output.

- [ ] **Step 3: Run the agency tests**

Run: `pnpm test:run`
Expected: All tests pass, including the MCP agency tests that now import from the package.

- [ ] **Step 4: Commit**

```bash
git add tests/agency-js/mcp/ tests/agency-js/mcp-tool-call/ tests/agency-js/mcp-catch-failure/
git commit -m "update MCP test fixtures to import from @agency-lang/mcp"
```

---

## Task 12: Update Examples and Documentation

**Files:**
- Modify: `examples/mcp/filesystem/agent.agency`
- Modify: `examples/mcp/github-oauth/agent.agency`
- Modify: `examples/mcp/github-oauth-ts/agent.agency`
- Modify: `docs-new/guide/mcp.md`

- [ ] **Step 1: Update example files**

Add `import { mcp } from "pkg::@agency-lang/mcp"` to each example `.agency` file.

- [ ] **Step 2: Update MCP documentation**

In `docs-new/guide/mcp.md`:

- Add installation instructions: `npm install @agency-lang/mcp`
- Update all code examples to include the import line
- Update the auth CLI section: change `agency auth` to `npx @agency-lang/mcp auth`
- Note that `mcp()` is no longer a builtin — it requires importing from the package

- [ ] **Step 3: Commit**

```bash
git add examples/mcp/ docs-new/guide/mcp.md
git commit -m "update MCP examples and docs for package extraction"
```

---

## Task 13: Final Verification

- [ ] **Step 1: Full build of main package**

Run: `pnpm run build`
Expected: PASS

- [ ] **Step 2: Full build of MCP package**

Run: `cd packages/mcp && pnpm run build`
Expected: PASS

- [ ] **Step 3: Full test suite**

Run: `pnpm test:run`
Expected: All tests pass.

- [ ] **Step 4: Verify @modelcontextprotocol/sdk is not in main package deps**

Run: `node -e "const p = require('./package.json'); console.log(p.dependencies['@modelcontextprotocol/sdk'] || 'NOT FOUND')"`
Expected: `NOT FOUND`

- [ ] **Step 5: Verify MCP package has the dependency**

Run: `node -e "const p = require('./packages/mcp/package.json'); console.log(p.dependencies['@modelcontextprotocol/sdk'])"`
Expected: `^1.29.0`

- [ ] **Step 6: Grep for stale MCP references in main package**

Run: `grep -r "mcpManager\|McpManager\|isMcpTool\|mcpToolToAgencyFunction\|mcp/mcpManager\|mcp/toolAdapter\|mcp/types" lib/ scripts/ --include='*.ts' | grep -v node_modules | grep -v '.test.ts'`
Expected: No matches (all MCP references removed from main package source).

- [ ] **Step 7: Commit any remaining fixes**

```bash
git add -A
git commit -m "final cleanup for MCP package extraction"
```
