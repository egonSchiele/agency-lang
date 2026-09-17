import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readMcpConfig, validateMcpServers } from "../src/configReader.js";

// No cleanup: this package cannot reach agency-lang's safeDeleteDirectoryWithin,
// and new code must not call a recursive rmSync. The OS clears its temp dir.
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-reader-")));
});

const write = (name: string, body: unknown) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(body));

describe("readMcpConfig", () => {
  it("merges servers from agency.local.json, replacing a server whole", () => {
    write("agency.json", {
      mcpServers: { search: { type: "http", url: "https://s/mcp" }, fs: { command: "npx" } },
    });
    write("agency.local.json", { mcpServers: { search: { command: "node" } } });
    expect(readMcpConfig(root)).toEqual({
      search: { command: "node" },
      fs: { command: "npx" },
    });
  });

  it("walks up to the project root", () => {
    write("agency.local.json", { mcpServers: { fs: { command: "npx" } } });
    const child = path.join(root, "a", "b");
    fs.mkdirSync(child, { recursive: true });
    expect(readMcpConfig(child)).toEqual({ fs: { command: "npx" } });
  });

  it("throws on an invalid server, naming the file", () => {
    write("agency.json", { mcpServers: { fs: { url: "no command" } } });
    expect(() => readMcpConfig(root)).toThrow(/agency\.json/);
  });
});

describe("validateMcpServers", () => {
  it("still validates a server map", () => {
    expect(validateMcpServers({ fs: { command: "npx" } }).success).toBe(true);
    expect(validateMcpServers({ fs: { nope: 1 } }).success).toBe(false);
  });
});
