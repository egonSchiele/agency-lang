import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import { _loadMcpToolsForServer } from "./mcp.js";

// Opt-in: needs the real @agency-lang/mcp package built and npx able to fetch
// @modelcontextprotocol/server-filesystem. Skipped in CI (RUN_MCP_INTEGRATION
// unset). Run with: RUN_MCP_INTEGRATION=1 npx vitest run lib/stdlib/mcp.integration.test.ts
const RUN = process.env.RUN_MCP_INTEGRATION === "1";

// The package is a workspace sibling but not a dependency of agency-lang, so
// point the resolver at its built entry (mirrors what a real install resolves).
const MCP_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../mcp/dist/src/mcp.js",
);

describe.skipIf(!RUN)("MCP integration (filesystem server)", () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.AGENCY_MCP_PATH;
    process.env.AGENCY_MCP_PATH = MCP_ENTRY;
  });
  afterAll(() => {
    if (prev === undefined) {
      delete process.env.AGENCY_MCP_PATH;
    } else {
      process.env.AGENCY_MCP_PATH = prev;
    }
  });

  it("loads gated tools from @modelcontextprotocol/server-filesystem", async () => {
    const config = {
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    };
    const tools = await _loadMcpToolsForServer("fs", config as any);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t: any) => t.name.startsWith("fs__"))).toBe(true);
  }, 60000);
});
