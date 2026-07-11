import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./mcpResolver.js", () => ({
  isMcpAvailable: vi.fn(() => true),
  exposeResolvedMcpPath: vi.fn(),
  resolveMcpEntry: vi.fn(() => "/x/mcp"),
}));
vi.mock("./mcpBridge.mjs", () => ({
  mcpRaw: vi.fn(),
  packageVersion: vi.fn(async () => "0.0.1"),
  mcpToolToAgencyFunction: vi.fn(async (tool) => ({ name: tool.name })),
  readProjectMcpConfig: vi.fn(async () => ({})),
}));

import * as bridge from "./mcpBridge.mjs";
import * as resolver from "./mcpResolver.js";
import { _mergeMcpServers, _loadMcpTools } from "./mcp.js";

const ok = (tools: any[]) => ({ success: true, value: { tools, callTool: async () => "r" } });
const bad = (msg: string) => ({ success: false, error: msg });

beforeEach(() => vi.clearAllMocks());

describe("_mergeMcpServers", () => {
  it("project overrides global", () => {
    expect(_mergeMcpServers({ a: 1, b: 2 } as any, { a: 9 } as any)).toEqual({ a: 9, b: 2 });
  });
});

describe("_loadMcpTools", () => {
  it("returns [] when the package is unavailable", async () => {
    (resolver.isMcpAvailable as any).mockReturnValueOnce(false);
    expect(await _loadMcpTools({ s: {} } as any)).toEqual([]);
  });

  it("wraps a server's tools", async () => {
    (bridge.mcpRaw as any).mockResolvedValue(ok([{ name: "s__t" }]));
    const tools = await _loadMcpTools({ s: {} } as any);
    expect(tools).toHaveLength(1);
    expect(bridge.mcpToolToAgencyFunction).toHaveBeenCalled();
  });

  it("skips a failing server but loads the others, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (bridge.mcpRaw as any)
      .mockResolvedValueOnce(bad("down")) // first server fails
      .mockResolvedValueOnce(ok([{ name: "g__t" }])); // second succeeds
    const tools = await _loadMcpTools({ broken: {}, good: {} } as any);
    expect(tools).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken"));
  });

  it("returns [] and warns when the version cannot be verified (T11)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (bridge.packageVersion as any).mockRejectedValueOnce(new Error("boom"));
    expect(await _loadMcpTools({ s: {} } as any)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("version"));
  });
});
