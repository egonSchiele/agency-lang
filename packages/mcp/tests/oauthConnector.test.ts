import { describe, it, expect, afterEach } from "vitest";
import { OAuthConnector } from "../src/oauthConnector.js";
import { TokenStore } from "../src/tokenStore.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("OAuthConnector", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should construct with server name, url, and token store", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-connector-test-"));
    const store = new TokenStore(tmpDir);
    const connector = new OAuthConnector("github", "https://example.com/mcp", store, { port: 0 });
    expect(connector).toBeDefined();
  });

  it("should throw when server is unreachable", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-connector-test-"));
    const store = new TokenStore(tmpDir);
    const connector = new OAuthConnector("test", "http://127.0.0.1:1/nonexistent", store, { port: 0 });

    await expect(connector.connect()).rejects.toThrow();
  });
});
