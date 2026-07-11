import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Validation goes through the package bridge; stub it so the CLI test needs no
// built package. The file I/O is real (temp dirs).
vi.mock("@/stdlib/mcpResolver.js", () => ({
  isMcpAvailable: vi.fn(() => true),
  exposeResolvedMcpPath: vi.fn(),
  resolveMcpEntry: vi.fn(() => "/x/mcp"),
}));
vi.mock("@/stdlib/mcpBridge.mjs", () => ({
  validateMcpServers: vi.fn(async () => ({ ok: true })),
  mcpRaw: vi.fn(),
  packageVersion: vi.fn(async () => "0.0.3"),
  mcpToolToAgencyFunction: vi.fn(),
  readProjectMcpConfig: vi.fn(async () => ({})),
}));

import { mcpCommand } from "./mcpCommand.js";
import type { AgencyConfig } from "@/config.js";

const cfg = {} as AgencyConfig;
let dir: string;
let cwd: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-"));
  cwd = process.cwd();
  process.chdir(dir); // project scope writes ./agency.json here
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

const agencyJson = () => JSON.parse(fs.readFileSync(path.join(dir, "agency.json"), "utf-8"));

describe("mcpCommand", () => {
  it("add (stdio) writes the project agency.json", async () => {
    const code = await mcpCommand(cfg, ["add", "fs", "--command", "npx", "--args", "-y,@mcp/server-filesystem,/tmp"]);
    expect(code).toBe(0);
    expect(agencyJson().mcpServers.fs).toEqual({ command: "npx", args: ["-y", "@mcp/server-filesystem", "/tmp"] });
  });

  it("add (http + oauth) sets type/url/auth", async () => {
    await mcpCommand(cfg, ["add", "gh", "--url", "https://x/mcp", "--oauth"]);
    expect(agencyJson().mcpServers.gh).toEqual({ type: "http", url: "https://x/mcp", auth: "oauth" });
  });

  it("add returns 1 with no transport", async () => {
    expect(await mcpCommand(cfg, ["add", "bad"])).toBe(1);
  });

  it("remove deletes and reports missing", async () => {
    await mcpCommand(cfg, ["add", "fs", "--command", "npx"]);
    expect(await mcpCommand(cfg, ["remove", "fs"])).toBe(0);
    expect(agencyJson().mcpServers).toEqual({});
    expect(await mcpCommand(cfg, ["remove", "fs"])).toBe(1);
  });

  it("list prints configured servers", async () => {
    await mcpCommand(cfg, ["add", "fs", "--command", "npx"]);
    const logs: string[] = [];
    (console.log as any).mockImplementation((s: string) => logs.push(s));
    expect(await mcpCommand(cfg, ["list"])).toBe(0);
    expect(logs.join("\n")).toContain("fs");
    expect(logs.join("\n")).toContain("[project]");
  });
});
