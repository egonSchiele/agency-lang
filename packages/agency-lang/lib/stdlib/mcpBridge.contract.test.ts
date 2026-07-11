import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as bridge from "./mcpBridge.mjs";

// The bridge -> real @agency-lang/mcp path is otherwise never exercised in CI:
// mcp.test.ts mocks the bridge, the resolver returns null in a monorepo, and
// the filesystem integration test is opt-in. This contract test points
// AGENCY_MCP_PATH at the built workspace package and asserts the four exports
// the bridge depends on exist and shape-match — the wiring most likely to rot
// on a signature change. No MCP server is spawned.
const MCP_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../mcp/dist/src/mcp.js",
);
const BUILT = fs.existsSync(MCP_ENTRY);

describe.skipIf(!BUILT)("mcpBridge <-> @agency-lang/mcp contract", () => {
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

  it("packageVersion returns a non-empty version string", async () => {
    const v = await bridge.packageVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });

  it("readProjectMcpConfig returns an object", async () => {
    const cfg = await bridge.readProjectMcpConfig(path.dirname(MCP_ENTRY));
    expect(typeof cfg).toBe("object");
  });

  it("mcpRaw returns a Result-shaped failure for an unknown server (no spawn)", async () => {
    const res = await bridge.mcpRaw("no-such-server", { config: {} });
    expect(res).toHaveProperty("success");
    expect(res.success).toBe(false);
  });

  it("mcpToolToAgencyFunction is callable and yields an AgencyFunction", async () => {
    const calls: string[] = [];
    const tool = { name: "srv__do", description: "d", serverName: "srv", inputSchema: { type: "object", properties: {} }, __mcpTool: true };
    const fn = await bridge.mcpToolToAgencyFunction(tool as any, async (s: string, t: string) => {
      calls.push(`${s}/${t}`);
      return "ok";
    });
    expect((fn as any).__agencyFunction).toBe(true);
    expect((fn as any).name).toBe("srv__do");
  });
});
