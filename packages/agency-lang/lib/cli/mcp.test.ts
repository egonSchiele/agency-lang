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

let dir: string;
let prevCwd: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cli-"));
  prevCwd = process.cwd();
  process.chdir(dir); // project scope → ./agency.json
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

const agencyJson = () => JSON.parse(fs.readFileSync(path.join(dir, "agency.json"), "utf-8"));

describe("mcpAdd", () => {
  it("writes a stdio server", async () => {
    expect(await mcpAdd("fs", { command: "npx", args: "-y,pkg,/tmp" })).toBe(0);
    expect(agencyJson().mcpServers.fs).toEqual({ command: "npx", args: ["-y", "pkg", "/tmp"] });
  });
  it("writes an http+oauth server", async () => {
    await mcpAdd("gh", { url: "https://x/mcp", oauth: true });
    expect(agencyJson().mcpServers.gh).toEqual({ type: "http", url: "https://x/mcp", auth: "oauth" });
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
