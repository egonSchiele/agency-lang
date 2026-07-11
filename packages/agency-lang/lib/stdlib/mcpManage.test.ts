import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("./mcpResolver.js", () => ({
  isMcpAvailable: vi.fn(() => true),
  exposeResolvedMcpPath: vi.fn(),
  resolveMcpEntry: vi.fn(() => "/x/mcp"),
}));
vi.mock("./mcpBridge.mjs", () => ({
  validateMcpServers: vi.fn(async () => ({ ok: true })),
  mcpRaw: vi.fn(),
  packageVersion: vi.fn(async () => "0.0.3"),
  mcpToolToAgencyFunction: vi.fn(),
  readProjectMcpConfig: vi.fn(async () => ({})),
}));

import * as resolver from "./mcpResolver.js";
import * as bridge from "./mcpBridge.mjs";
import {
  _validateMcpServers,
  _readMcpServersFromFile,
  _upsertMcpServerInFile,
  _removeMcpServerFromFile,
  _addMcpServer,
  _parseMcpCommand,
  _dropMcpToolsForServer,
} from "./mcp.js";

let dir: string;
let file: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-manage-"));
  file = path.join(dir, "agency.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("_upsertMcpServerInFile", () => {
  it("creates the file when absent", () => {
    _upsertMcpServerInFile(file, "fs", { command: "npx" });
    expect(_readMcpServersFromFile(file)).toEqual({ fs: { command: "npx" } });
  });

  it("preserves other top-level keys", () => {
    fs.writeFileSync(file, JSON.stringify({ model: { pin: "x" }, mcpServers: { a: { command: "a" } } }));
    _upsertMcpServerInFile(file, "b", { type: "http", url: "https://x" });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(raw.model).toEqual({ pin: "x" });
    expect(Object.keys(raw.mcpServers).sort()).toEqual(["a", "b"]);
  });

  it("is prototype-safe for a __proto__ server name", () => {
    _upsertMcpServerInFile(file, "__proto__", { command: "x" });
    expect(({} as any).command).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(_readMcpServersFromFile(file), "__proto__")).toBe(true);
  });
});

describe("_removeMcpServerFromFile", () => {
  it("returns false for a missing server and true when removed", () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    expect(_removeMcpServerFromFile(file, "nope")).toBe(false);
    expect(_removeMcpServerFromFile(file, "a")).toBe(true);
    expect(_readMcpServersFromFile(file)).toEqual({});
  });
});

describe("_validateMcpServers", () => {
  it("fails clearly when the package is unavailable", async () => {
    (resolver.isMcpAvailable as any).mockReturnValueOnce(false);
    const r = await _validateMcpServers({ a: { command: "x" } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not installed");
  });

  it("delegates to the bridge when available", async () => {
    (bridge.validateMcpServers as any).mockResolvedValueOnce({ ok: false, error: "bad" });
    expect(await _validateMcpServers({ a: {} })).toEqual({ ok: false, error: "bad" });
  });
});

describe("_addMcpServer", () => {
  it("writes on valid config and skips write on invalid", async () => {
    const ok = await _addMcpServer("fs", { command: "npx" }, file);
    expect(ok.ok).toBe(true);
    expect(_readMcpServersFromFile(file)).toEqual({ fs: { command: "npx" } });

    (bridge.validateMcpServers as any).mockResolvedValueOnce({ ok: false, error: "nope" });
    const bad = await _addMcpServer("x", { url: "http://x" }, file);
    expect(bad.ok).toBe(false);
    expect(_readMcpServersFromFile(file).x).toBeUndefined(); // not written
  });
});

describe("_parseMcpCommand", () => {
  it("parses add stdio with comma args", () => {
    const p = _parseMcpCommand("add fs --command npx --args -y,pkg,/tmp");
    expect(p).toMatchObject({ sub: "add", name: "fs", global: false, error: null });
    expect(p.config).toEqual({ command: "npx", args: ["-y", "pkg", "/tmp"] });
  });
  it("parses add http + oauth + global", () => {
    const p = _parseMcpCommand("add gh --url https://x --oauth --global");
    expect(p.global).toBe(true);
    expect(p.config).toEqual({ type: "http", url: "https://x", auth: "oauth" });
  });
  it("errors when add has no transport", () => {
    expect(_parseMcpCommand("add bad").error).toBeTruthy();
  });
  it("parses remove", () => {
    expect(_parseMcpCommand("remove fs")).toMatchObject({ sub: "remove", name: "fs", error: null });
  });
});

describe("_dropMcpToolsForServer", () => {
  it("removes only the named server's tools", () => {
    const tools = [{ module: "mcp:fs" }, { module: "mcp:gh" }, { module: "other" }] as any;
    const left = _dropMcpToolsForServer(tools, "fs");
    expect(left.map((t: any) => t.module)).toEqual(["mcp:gh", "other"]);
  });
});
