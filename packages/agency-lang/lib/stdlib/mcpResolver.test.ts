import { describe, it, expect, afterEach } from "vitest";
import { isMcpAvailable, exposeResolvedMcpPath, resolveMcpEntry } from "./mcpResolver.js";

afterEach(() => {
  delete process.env.AGENCY_MCP_PATH;
});

describe("mcpResolver", () => {
  it("is unresolvable in a monorepo checkout (agency-lang does not depend on the package)", () => {
    // Same as smoltalk-llama-cpp: an optional package, absent from agency-lang's
    // deps, is not reachable here. A real user installs it alongside agency-lang
    // (or globally), where Node's node_modules walk finds it.
    expect(resolveMcpEntry()).toBeNull();
    expect(isMcpAvailable()).toBe(false);
  });

  it("honors the AGENCY_MCP_PATH override", () => {
    process.env.AGENCY_MCP_PATH = "/some/where/mcp.js";
    expect(resolveMcpEntry()).toBe("/some/where/mcp.js");
    expect(isMcpAvailable()).toBe(true);
  });

  it("exposeResolvedMcpPath is a no-op when unresolvable and idempotent when preset", () => {
    exposeResolvedMcpPath();
    expect(process.env.AGENCY_MCP_PATH).toBeUndefined();
    process.env.AGENCY_MCP_PATH = "/preset";
    exposeResolvedMcpPath();
    expect(process.env.AGENCY_MCP_PATH).toBe("/preset");
  });
});
