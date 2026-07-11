import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { success, failure, isFailure, isSuccess } from "../runtime/index.js";

vi.mock("./mcpResolver.js", () => ({
  isMcpAvailable: vi.fn(() => true),
  exposeResolvedMcpPath: vi.fn(),
  resolveMcpEntry: vi.fn(() => "/x/mcp"),
}));
vi.mock("./mcpBridge.mjs", () => ({
  validateMcpServers: vi.fn(async () => success(null)),
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
  _addMcpServer,
  _removeMcpServer,
} from "./mcp.js";

let dir: string;
let file: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-manage-"));
  file = path.join(dir, "agency.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const readRaw = () => JSON.parse(fs.readFileSync(file, "utf-8"));

describe("_addMcpServer", () => {
  it("creates the file and writes the server", async () => {
    expect(isSuccess(await _addMcpServer("fs", { command: "npx" }, file))).toBe(true);
    expect(_readMcpServersFromFile(file)).toEqual({ fs: { command: "npx" } });
  });

  it("preserves other top-level keys", async () => {
    fs.writeFileSync(file, JSON.stringify({ model: { pin: "x" }, mcpServers: { a: { command: "a" } } }));
    await _addMcpServer("b", { type: "http", url: "https://x" }, file);
    const raw = readRaw();
    expect(raw.model).toEqual({ pin: "x" });
    expect(Object.keys(raw.mcpServers).sort()).toEqual(["a", "b"]);
  });

  it("is prototype-safe for a __proto__ server name", async () => {
    await _addMcpServer("__proto__", { command: "x" }, file);
    expect(({} as any).command).toBeUndefined();
  });

  it("does NOT write (no data loss) when the file exists but is malformed JSON", async () => {
    fs.writeFileSync(file, "{ not valid json,,,");
    const res = await _addMcpServer("fs", { command: "npx" }, file);
    expect(isFailure(res)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("{ not valid json,,,"); // untouched
  });

  it("fails without writing when validation fails", async () => {
    (bridge.validateMcpServers as any).mockResolvedValueOnce(failure("bad"));
    const res = await _addMcpServer("x", { url: "http://x" }, file);
    expect(isFailure(res)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("_removeMcpServer", () => {
  it("success(false) for a missing server, success(true) when removed", async () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    const miss = await _removeMcpServer("nope", file);
    expect(isSuccess(miss) && miss.value).toBe(false);
    const hit = await _removeMcpServer("a", file);
    expect(isSuccess(hit) && hit.value).toBe(true);
    expect(_readMcpServersFromFile(file)).toEqual({});
  });

  it("does not treat prototype members (toString) as present", async () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    const res = await _removeMcpServer("toString", file);
    expect(isSuccess(res) && res.value).toBe(false);
  });

  it("fails on a malformed file without rewriting it", async () => {
    fs.writeFileSync(file, "not json");
    expect(isFailure(await _removeMcpServer("a", file))).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("not json");
  });
});

describe("_readMcpServersFromFile (lenient)", () => {
  it("returns {} for absent, malformed, or array-root files", () => {
    expect(_readMcpServersFromFile(file)).toEqual({});
    fs.writeFileSync(file, "nope");
    expect(_readMcpServersFromFile(file)).toEqual({});
    fs.writeFileSync(file, "[]");
    expect(_readMcpServersFromFile(file)).toEqual({});
  });
});

describe("_validateMcpServers", () => {
  it("fails clearly when the package is unavailable", async () => {
    (resolver.isMcpAvailable as any).mockReturnValueOnce(false);
    const r = await _validateMcpServers({ a: { command: "x" } });
    expect(isFailure(r)).toBe(true);
    expect(String(r.error)).toContain("not installed");
  });

  it("treats a bridge throw (old package) as a clear failure, not a crash", async () => {
    (bridge.validateMcpServers as any).mockRejectedValueOnce(new TypeError("not a function"));
    const r = await _validateMcpServers({ a: {} });
    expect(isFailure(r)).toBe(true);
    expect(String(r.error)).toContain("upgrade");
  });
});
