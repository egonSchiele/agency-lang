import { describe, it, expect } from "vitest";
import { startFakeOAuthServer, freePort } from "./fakeOAuthServer.js";

describe("fakeOAuthServer", () => {
  it("refuses MCP without a token", async () => {
    const server = await startFakeOAuthServer();
    const res = await fetch(server.mcpUrl, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    await server.close();
  });

  it("serves the metadata the SDK discovers", async () => {
    const server = await startFakeOAuthServer();
    const origin = new URL(server.mcpUrl).origin;
    const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource.authorization_servers).toEqual([origin]);
    const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.token_endpoint).toBe(`${origin}/token`);
    await server.close();
  });

  it("freePort returns a port a server can bind", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
  });
});
