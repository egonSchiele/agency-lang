import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readBinding, writeBinding } from "./binding.js";

const HOST = "https://statelog.example";
const SERVE_URL = `${HOST}/serve/u/proj/agent.agency`;

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-binding-"));
  configPath = path.join(dir, "agency.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readBinding", () => {
  it("parses a valid canonical serve URL from remote.serveUrl", () => {
    fs.writeFileSync(configPath, JSON.stringify({ remote: { serveUrl: SERVE_URL } }));
    const binding = readBinding(configPath);
    expect(binding).toMatchObject({ userId: "u", projectId: "proj", filename: "agent.agency" });
  });

  it("returns null for a missing file or config without remote", () => {
    expect(readBinding(configPath)).toBeNull();
    fs.writeFileSync(configPath, JSON.stringify({ log: { host: HOST } }));
    expect(readBinding(configPath)).toBeNull();
  });

  it("returns null for a malformed / non-canonical serve URL", () => {
    for (const bad of [
      `${HOST}/serve/u/proj/agent/node/main`,
      `https://user:pw@statelog.example/serve/u/p/a`,
      `${HOST}/serve/u/p/a?x=1`,
      "not a url",
    ]) {
      fs.writeFileSync(configPath, JSON.stringify({ remote: { serveUrl: bad } }));
      expect(readBinding(configPath)).toBeNull();
    }
  });
});

describe("writeBinding", () => {
  const binding = { serveUrl: SERVE_URL, origin: HOST, userId: "u", projectId: "proj", filename: "agent.agency" };

  it("adds remote.serveUrl and preserves unrelated keys", () => {
    fs.writeFileSync(configPath, JSON.stringify({ log: { host: HOST }, custom: 1 }));
    writeBinding(configPath, binding);
    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written).toEqual({ log: { host: HOST }, custom: 1, remote: { serveUrl: SERVE_URL } });
  });

  it("creates the file when missing", () => {
    writeBinding(configPath, binding);
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toEqual({
      remote: { serveUrl: SERVE_URL },
    });
  });

  it("throws on invalid JSON and leaves the file unchanged", () => {
    const bytes = "{ not json";
    fs.writeFileSync(configPath, bytes);
    expect(() => writeBinding(configPath, binding)).toThrow();
    expect(fs.readFileSync(configPath, "utf-8")).toBe(bytes);
  });

  it("rejects a scalar or array root without modifying the file", () => {
    for (const bytes of ["[1,2,3]", "42"]) {
      fs.writeFileSync(configPath, bytes);
      expect(() => writeBinding(configPath, binding)).toThrow();
      expect(fs.readFileSync(configPath, "utf-8")).toBe(bytes);
    }
  });
});
