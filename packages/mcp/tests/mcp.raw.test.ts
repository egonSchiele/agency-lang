import { describe, it, expect } from "vitest";
import { mcpRaw, MCP_PACKAGE_VERSION } from "../src/mcp.js";
import { createRequire } from "node:module";

const realVersion = createRequire(import.meta.url)("../package.json").version;

describe("mcpRaw", () => {
  it("uses the INJECTED config (not agency.json): an injected-but-not-on-disk server is attempted", async () => {
    // "injected-only" is not in any agency.json; if injection works, getTools
    // finds it in config and tries to connect (and fails to connect, not
    // "not found in config"). If injection were ignored, it would be a
    // config-miss instead. We assert failure either way but check the message
    // proves the server was known to the manager.
    const res = await mcpRaw("injected-only", {
      config: { "injected-only": { command: "false", args: [] } },
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).not.toContain("not found in agency.json");
  });

  it("reports the real package version", () => {
    expect(MCP_PACKAGE_VERSION).toBe(realVersion);
    expect(MCP_PACKAGE_VERSION).not.toBe("0.0.0");
  });
});
