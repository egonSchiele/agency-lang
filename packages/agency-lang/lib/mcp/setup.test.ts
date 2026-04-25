import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { renderCodexMcpServerBlock, setupCodexMcp } from "./setup.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mcp-setup-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("renderCodexMcpServerBlock", () => {
  it("renders a codex MCP server block", () => {
    const block = renderCodexMcpServerBlock(["node", "/tmp/agency.js", "mcp"]);

    expect(block).toContain("[mcp_servers.agency]");
    expect(block).toContain('command = "node"');
    expect(block).toContain('args = ["/tmp/agency.js", "mcp"]');
  });
});

describe("setupCodexMcp", () => {
  it("creates a new config file", () => {
    const configPath = path.join(tmpDir, "config.toml");

    const result = setupCodexMcp(configPath, ["node", "/tmp/agency.js", "mcp"]);

    expect(result.ok).toBe(true);
    const config = fs.readFileSync(configPath, "utf-8");
    expect(config).toContain("[mcp_servers.agency]");
  });

  it("replaces an existing agency MCP server section", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        '[mcp_servers.agency]',
        'command = "old"',
        '',
        '[mcp_servers.other]',
        'command = "other"',
        '',
      ].join("\n"),
    );

    setupCodexMcp(configPath, ["node", "/tmp/agency.js", "mcp"]);

    const config = fs.readFileSync(configPath, "utf-8");
    expect(config).toContain('command = "node"');
    expect(config).not.toContain('command = "old"');
    expect(config).toContain('[mcp_servers.other]');
  });
});
