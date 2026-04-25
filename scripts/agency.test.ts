import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCli } from "./agency.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runCli", () => {
  it("awaits the async lsp startup path", async () => {
    const startServer = vi.fn();
    const loadLspStartServer = vi.fn(async () => startServer);

    await runCli(["node", "agency", "lsp"], { loadLspStartServer });

    expect(loadLspStartServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("awaits the async mcp startup path", async () => {
    const startServer = vi.fn();
    const loadMcpStartServer = vi.fn(async () => startServer);

    await runCli(["node", "agency", "mcp"], { loadMcpStartServer });

    expect(loadMcpStartServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("writes Codex MCP config to an explicit path", async () => {
    const configPath = path.join(tmpDir, "config.toml");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(
      ["node", "agency", "mcp", "setup", "codex", "--codex-config", configPath],
      { resolveMcpCommand: () => ["node", "/tmp/agency.js", "mcp"] },
    );

    expect(fs.readFileSync(configPath, "utf-8")).toContain('[mcp_servers.agency]');
    expect(fs.readFileSync(configPath, "utf-8")).toContain('command = "node"');
    logSpy.mockRestore();
  });

  it("uses the stable agency executable for default Codex MCP setup", async () => {
    const configPath = path.join(tmpDir, "config.toml");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(
      ["node", "agency", "mcp", "setup", "codex", "--codex-config", configPath],
    );

    const written = fs.readFileSync(configPath, "utf-8");
    expect(written).toContain('[mcp_servers.agency]');
    expect(written).toContain('command = "agency"');
    expect(written).toContain('args = ["mcp"]');
    expect(written).not.toContain("/tmp/");
    logSpy.mockRestore();
  });
});
