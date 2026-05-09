# Standalone Server Bundling

## Problem

`agency serve http --standalone myagent.agency` currently bundles the compiled module with esbuild, but the output is just the compiled agent code — it doesn't start a server. The user expects a self-contained `server.js` they can deploy with `node server.js` on any machine without installing Agency.

## Design

Generate a small entrypoint file that imports the compiled module and starts the appropriate server, then bundle everything (including node_modules) with esbuild into a single file.

### How it works

When `--standalone` is passed on either `serve http` or `serve mcp`:

1. Compile the agency file as usual (produces e.g. `myagent.js`)
2. Generate a temporary entrypoint file that wires up discovery and the server
3. Bundle the entrypoint with esbuild, inlining all dependencies
4. Delete the temporary entrypoint and compiled JS
5. Output `myagent.server.js`

The output file is fully self-contained — copy it to any machine with Node.js and run `node myagent.server.js`.

### HTTP entrypoint template

```javascript
import * as mod from "./myagent.js";
import { discoverExports } from "agency-lang/serve/discovery";
import { startHttpServer } from "agency-lang/serve/http/adapter";
import { createLogger } from "agency-lang/logger";

const exports = discoverExports({
  toolRegistry: mod.__toolRegistry ?? {},
  moduleExports: mod,
  moduleId: "myagent.agency",
  exportedNodeNames: ["main"],
  exportedConstantNames: [],
});

const port = parseInt(process.env.PORT ?? "3545", 10);
startHttpServer({
  exports,
  port,
  apiKey: process.env.API_KEY,
  logger: createLogger("info"),
  hasInterrupts: mod.hasInterrupts,
  respondToInterrupts: mod.respondToInterrupts,
});
```

### MCP entrypoint template

Same discovery preamble, different server start:

```javascript
import { createMcpHandler, startStdioServer } from "agency-lang/serve/mcp/adapter";

const handler = createMcpHandler({
  serverName: "myagent",
  serverVersion: "1.0.0",
  exports,
});
startStdioServer(handler);
```

### esbuild config

```javascript
await esbuild.build({
  entryPoints: [entrypointPath],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "myagent.server.js",
});
```

All node_modules are bundled so the output is truly standalone.

### CLI flags

**`agency serve http --standalone <file>`**
- `--port <port>` — Default port baked into the file (overridable via `PORT` env var at runtime)
- `--api-key-env <name>` — Name of the environment variable to read the API key from (default: `API_KEY`). The key itself is never baked into the bundle.

**`agency serve mcp --standalone <file>`**
- `--name <name>` — Server name baked into the MCP initialize response

### Implementation

The `generateStandalone` function in `lib/cli/serve.ts` needs:

1. A `mode` parameter (`"http" | "mcp"`) to pick the right template
2. The `CompileResult` (moduleId, exportedNodeNames, exportedConstantNames) to fill in the discovery call
3. CLI options (port, apiKeyEnv, name) to bake into the template

The entrypoint is generated as a string (no template engine needed — it's ~15 lines), written to a temp file next to the compiled JS, bundled, then both temp files are cleaned up.
