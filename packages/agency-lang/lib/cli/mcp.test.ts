import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { success, failure } from "@/runtime/index.js";

vi.mock("@/stdlib/mcpResolver.js", () => ({
  isMcpAvailable: vi.fn(() => true),
  exposeResolvedMcpPath: vi.fn(),
  resolveMcpEntry: vi.fn(() => "/x/mcp"),
}));
vi.mock("@/stdlib/mcpBridge.mjs", () => ({
  validateMcpServers: vi.fn(async () => success(null)),
  mcpRaw: vi.fn(),
  packageVersion: vi.fn(async () => "0.0.3"),
  mcpToolToAgencyFunction: vi.fn(),
  readProjectMcpConfig: vi.fn(async () => ({})),
}));

import * as bridge from "@/stdlib/mcpBridge.mjs";
import { mcpAdd, mcpRemove, mcpList } from "./mcp.js";
import { fileTarget } from "@/config/target.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";

let dir: string;
let prevCwd: string;
let previousAgentHome: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-")));
  prevCwd = process.cwd();
  process.chdir(dir); // project scope → ./agency.json
  // --global writes here, never to the real ~/.agency-agent.
  previousAgentHome = process.env.AGENCY_AGENT_HOME;
  process.env.AGENCY_AGENT_HOME = path.join(dir, "agent-home");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (previousAgentHome === undefined) {
    delete process.env.AGENCY_AGENT_HOME;
  } else {
    process.env.AGENCY_AGENT_HOME = previousAgentHome;
  }
  process.chdir(prevCwd);
  expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
});

const agencyJson = () => JSON.parse(fs.readFileSync(path.join(dir, "agency.json"), "utf-8"));

describe("mcpAdd", () => {
  it("writes a stdio server", async () => {
    expect(await mcpAdd("fs", { command: "npx", args: "-y,pkg,/tmp" })).toBe(0);
    expect(agencyJson().mcpServers.fs).toEqual({ command: "npx", args: ["-y", "pkg", "/tmp"] });
  });
  it("writes an http+oauth server", async () => {
    await mcpAdd("gh", { url: "https://x/mcp", oauth: true });
    expect(agencyJson().mcpServers.gh).toEqual({
      type: "http",
      url: "https://x/mcp",
      auth: "oauth",
    });
  });
  it("returns 1 with no transport", async () => {
    expect(await mcpAdd("bad", {})).toBe(1);
  });
  it("returns 1 and writes nothing when validation fails", async () => {
    (bridge.validateMcpServers as any).mockResolvedValueOnce(failure("bad url"));
    expect(await mcpAdd("x", { url: "http://x" })).toBe(1);
    expect(fs.existsSync(path.join(dir, "agency.json"))).toBe(false);
  });
});

describe("mcpRemove", () => {
  it("removes and reports missing", async () => {
    await mcpAdd("fs", { command: "npx" });
    expect(await mcpRemove("fs", {})).toBe(0);
    expect(agencyJson().mcpServers).toEqual({});
    expect(await mcpRemove("fs", {})).toBe(1);
  });
});

describe("mcpList", () => {
  it("lists configured servers with source", async () => {
    await mcpAdd("fs", { command: "npx" });
    const logs: string[] = [];
    (console.log as any).mockImplementation((s: string) => logs.push(s));
    expect(mcpList()).toBe(0);
    expect(logs.join("\n")).toContain("fs");
    expect(logs.join("\n")).toContain("[project]");
  });
});

describe("config targets", () => {
  it("add and remove write to a file target", async () => {
    const teamFile = path.join(dir, "team.json");
    const target = fileTarget(teamFile);
    expect(await mcpAdd("fs", { command: "npx" }, target)).toBe(0);
    expect(JSON.parse(fs.readFileSync(teamFile, "utf-8")).mcpServers.fs).toEqual({
      command: "npx",
    });
    expect(fs.existsSync(path.join(dir, "agency.json"))).toBe(false);

    expect(await mcpRemove("fs", {}, target)).toBe(0);
    expect(JSON.parse(fs.readFileSync(teamFile, "utf-8")).mcpServers).toEqual({});
  });

  it("refuses a file target together with --global, and writes nothing", async () => {
    const teamFile = path.join(dir, "team.json");
    const target = fileTarget(teamFile);
    expect(await mcpAdd("fs", { command: "npx", global: true }, target)).toBe(1);
    expect(await mcpRemove("fs", { global: true }, target)).toBe(1);
    expect(fs.existsSync(teamFile)).toBe(false);
    expect(fs.existsSync(path.join(dir, "agent-home"))).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--global"));
  });

  it("list reads a file target", async () => {
    const target = fileTarget(path.join(dir, "team.json"));
    await mcpAdd("fs", { command: "npx" }, target);
    const logs: string[] = [];
    (console.log as any).mockImplementation((line: string) => logs.push(line));
    expect(mcpList(target)).toBe(0);
    expect(logs.join("\n")).toContain("fs");
  });

  it("list shows servers from both project files", () => {
    fs.writeFileSync(
      path.join(dir, "agency.json"),
      JSON.stringify({ mcpServers: { team: { command: "npx" } } }),
    );
    fs.writeFileSync(
      path.join(dir, "agency.local.json"),
      JSON.stringify({ mcpServers: { mine: { type: "http", url: "https://m/mcp" } } }),
    );
    const logs: string[] = [];
    (console.log as any).mockImplementation((line: string) => logs.push(line));
    expect(mcpList()).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("team");
    expect(out).toContain("mine — http https://m/mcp [project]");
  });

  it("list fails when the project config does not load", () => {
    fs.writeFileSync(path.join(dir, "agency.local.json"), "{ not json");
    expect(mcpList()).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("agency.local.json"));
  });
});
